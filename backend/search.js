'use strict';
// An Elasticsearch-flavoured document index: inverted index with prefix lookup,
// a small query-string language (field:value, field:>n, -field:value, "phrases"),
// terms / date_histogram / sum / avg aggregations, sorting and paging.

function tokens(v) {
  return String(v).toLowerCase().split(/[^a-z0-9@._-]+/).filter(Boolean);
}

function getPath(obj, path) {
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function parseQuery(q) {
  const out = [];
  const re = /(-?[\w.]+:(?:"[^"]*"|\S+))|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    if (m[1]) {
      let s = m[1];
      let neg = false;
      if (s[0] === '-') {
        neg = true;
        s = s.slice(1);
      }
      const i = s.indexOf(':');
      const field = s.slice(0, i);
      let val = s.slice(i + 1).replace(/^"|"$/g, '');
      let op = null;
      const om = /^(>=|<=|>|<)(.+)$/.exec(val);
      if (om) {
        op = om[1];
        val = om[2];
      }
      out.push({ kind: 'field', field, val, op, neg });
    } else {
      const v = m[2] !== undefined ? m[2] : m[3];
      if (v.toUpperCase() === 'AND') continue;
      out.push({ kind: 'text', val: v });
    }
  }
  return out;
}

function fieldMatch(v, c) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.some((x) => fieldMatch(x, c));
  if (c.op) {
    const n = Number(v);
    const t = Number(c.val);
    if (isNaN(n) || isNaN(t)) return false;
    return c.op === '>' ? n > t : c.op === '<' ? n < t : c.op === '>=' ? n >= t : n <= t;
  }
  const s = String(v).toLowerCase();
  const t = c.val.toLowerCase();
  if (t.includes('*')) {
    const re = new RegExp('^' + t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(s);
  }
  return s === t || s.includes(t);
}

class SearchIndex {
  constructor() {
    this.docs = [];
    this.terms = new Map();
    this.byIndex = new Map();
    this.entryOf = new WeakMap();
  }

  _tokenize(entry) {
    const toks = new Set();
    const parts = [];
    const walk = (v) => {
      if (v == null) return;
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object') Object.values(v).forEach(walk);
      else {
        parts.push(String(v).toLowerCase());
        for (const t of tokens(v)) {
          toks.add(t);
          // also index the pieces of dotted / underscored / hyphenated terms (auth.login -> auth, login)
          for (const part of t.split(/[._@-]+/)) if (part && part !== t) toks.add(part);
        }
      }
    };
    walk(entry._source);
    entry._toks = toks;
    entry._text = parts.join(' ');
    for (const t of toks) {
      let s = this.terms.get(t);
      if (!s) {
        s = new Set();
        this.terms.set(t, s);
      }
      s.add(entry._id);
    }
  }

  index(indexName, doc) {
    const entry = { _id: this.docs.length, _index: indexName, _source: doc };
    this.docs.push(entry);
    this.entryOf.set(doc, entry);
    if (!this.byIndex.has(indexName)) this.byIndex.set(indexName, []);
    this.byIndex.get(indexName).push(entry);
    this._tokenize(entry);
    return entry._id;
  }

  // Re-tokenise a document after it was mutated (status changes etc).
  refresh(doc) {
    const e = this.entryOf.get(doc);
    if (!e) return;
    for (const t of e._toks) {
      const s = this.terms.get(t);
      if (s) s.delete(e._id);
    }
    this._tokenize(e);
  }

  stats() {
    const indices = {};
    for (const [k, v] of this.byIndex) indices[k] = v.length;
    return { docs: this.docs.length, terms: this.terms.size, indices };
  }

  search({ index, q = '', filters = {}, from = 0, size = 50, sort = 'ts', order = 'desc', aggs = null } = {}) {
    const t0 = process.hrtime.bigint();
    const clauses = parseQuery(q);
    let cand = null;
    for (const c of clauses.filter((x) => x.kind === 'text')) {
      for (const tok of tokens(c.val)) {
        const ids = new Set();
        for (const [term, set] of this.terms) {
          if (term.startsWith(tok)) for (const id of set) ids.add(id);
        }
        cand = cand ? new Set([...cand].filter((id) => ids.has(id))) : ids;
      }
    }
    let pool;
    if (cand) pool = [...cand].map((id) => this.docs[id]);
    else pool = index ? this.byIndex.get(index) || [] : this.docs;

    const fkeys = Object.entries(filters).filter(([, v]) => v !== undefined && v !== '' && v !== null);
    const matches = pool.filter((e) => {
      if (index && e._index !== index) return false;
      for (const [k, v] of fkeys) {
        const val = getPath(e._source, k);
        if (Array.isArray(v)) {
          if (!v.map(String).includes(String(val))) return false;
        } else if (String(val) !== String(v)) return false;
      }
      for (const c of clauses) {
        if (c.kind === 'text') {
          if (!e._text.includes(c.val.toLowerCase())) return false;
        } else {
          const hit = fieldMatch(getPath(e._source, c.field), c);
          if (c.neg ? hit : !hit) return false;
        }
      }
      return true;
    });

    const dir = order === 'asc' ? 1 : -1;
    matches.sort((a, b) => {
      const x = getPath(a._source, sort);
      const y = getPath(b._source, sort);
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });

    const res = {
      total: matches.length,
      hits: matches.slice(from, from + size),
      aggregations: {},
    };
    if (aggs) {
      for (const [name, spec] of Object.entries(aggs)) {
        if (spec.terms) {
          const m = new Map();
          for (const e of matches) {
            const v = getPath(e._source, spec.terms.field);
            for (const x of Array.isArray(v) ? v : [v]) {
              if (x == null) continue;
              m.set(x, (m.get(x) || 0) + 1);
            }
          }
          res.aggregations[name] = {
            buckets: [...m]
              .map(([key, doc_count]) => ({ key, doc_count }))
              .sort((a, b) => b.doc_count - a.doc_count)
              .slice(0, spec.terms.size || 10),
          };
        } else if (spec.date_histogram) {
          const { field, interval_ms: iv, sub_sum: subSum } = spec.date_histogram;
          const m = new Map();
          for (const e of matches) {
            const v = getPath(e._source, field);
            if (typeof v !== 'number') continue;
            const key = Math.floor(v / iv) * iv;
            const b = m.get(key) || { key, doc_count: 0, sum: 0 };
            b.doc_count++;
            if (subSum) b.sum += Number(getPath(e._source, subSum)) || 0;
            m.set(key, b);
          }
          res.aggregations[name] = { buckets: [...m.values()].sort((a, b) => a.key - b.key) };
        } else if (spec.sum || spec.avg) {
          const field = spec.sum || spec.avg;
          const nums = matches.map((e) => Number(getPath(e._source, field))).filter((n) => !isNaN(n));
          const s = nums.reduce((a, b) => a + b, 0);
          res.aggregations[name] = { value: spec.sum ? s : nums.length ? s / nums.length : 0 };
        }
      }
    }
    res.took_ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return res;
  }
}

module.exports = { SearchIndex, parseQuery, getPath };
