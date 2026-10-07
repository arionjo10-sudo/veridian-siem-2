'use strict';
// A tiny in-memory relational store with a read-only SQL subset:
// SELECT cols|*|agg(col) FROM t [WHERE a = 'x' AND b > 5 | IN | LIKE] [GROUP BY c] [ORDER BY c [DESC]] [LIMIT n]

class Table {
  constructor(name, pk) {
    this.name = name;
    this.pk = pk;
    this.rows = [];
    this.idx = new Map();
  }
  insert(row) {
    this.rows.push(row);
    if (this.pk) this.idx.set(row[this.pk], row);
    return row;
  }
  get(id) {
    return this.idx.get(id);
  }
  find(fn) {
    return fn ? this.rows.filter(fn) : this.rows.slice();
  }
  update(id, patch) {
    const r = this.get(id);
    if (r) Object.assign(r, patch);
    return r;
  }
}

function parseValue(s) {
  s = s.trim();
  if (/^'.*'$/s.test(s) || /^".*"$/s.test(s)) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^null$/i.test(s)) return null;
  throw new Error('Bad literal: ' + s);
}

function cond(c) {
  c = c.trim();
  let m = /^(\w+)\s+in\s*\((.+)\)$/i.exec(c);
  if (m) {
    const vals = m[2].split(',').map(parseValue);
    return (r) => vals.includes(r[m[1]]);
  }
  m = /^(\w+)\s*(>=|<=|!=|<>|=|>|<|like)\s*(.+)$/i.exec(c);
  if (!m) throw new Error('Cannot parse condition: ' + c);
  const col = m[1];
  const op = m[2].toLowerCase();
  const val = parseValue(m[3]);
  if (op === 'like') {
    const re = new RegExp(
      '^' + String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$',
      'i'
    );
    return (r) => re.test(String(r[col] ?? ''));
  }
  return (r) => {
    const v = r[col];
    switch (op) {
      case '=': return v == val; // eslint-disable-line eqeqeq
      case '!=':
      case '<>': return v != val; // eslint-disable-line eqeqeq
      case '>': return v > val;
      case '<': return v < val;
      case '>=': return v >= val;
      case '<=': return v <= val;
      default: return false;
    }
  };
}

function agg(fn, col, rows) {
  if (fn === 'count') return col === '*' ? rows.length : rows.filter((r) => r[col] != null).length;
  const nums = rows.map((r) => Number(r[col])).filter((n) => !isNaN(n));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  switch (fn) {
    case 'sum': return Math.round(sum * 100) / 100;
    case 'avg': return Math.round((sum / nums.length) * 100) / 100;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    default: return null;
  }
}

const COL_RE = /^(\*|(count|sum|avg|min|max)\(\s*(\*|\w+)\s*\)|\w+)(?:\s+as\s+(\w+))?$/i;
const SELECT_RE =
  /^\s*select\s+(.+?)\s+from\s+(\w+)(?:\s+where\s+(.+?))?(?:\s+group\s+by\s+(\w+))?(?:\s+order\s+by\s+(\w+)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?\s*;?\s*$/is;

class Database {
  constructor() {
    this.tables = {};
  }
  create(name, pk) {
    const t = new Table(name, pk);
    this.tables[name] = t;
    this[name] = t;
    return t;
  }
  table(n) {
    const t = this.tables[n];
    if (!t) throw new Error(`Unknown table: ${n}. Tables: ${Object.keys(this.tables).join(', ')}`);
    return t;
  }
  list() {
    return Object.values(this.tables).map((t) => ({ name: t.name, rows: t.rows.length, pk: t.pk }));
  }

  query(sql) {
    const t0 = Date.now();
    if (!/^\s*select\b/i.test(sql)) throw new Error('Only SELECT statements are allowed');
    const m = SELECT_RE.exec(sql);
    if (!m) {
      throw new Error(
        'Syntax error. Supported: SELECT cols FROM table [WHERE ...] [GROUP BY col] [ORDER BY col [ASC|DESC]] [LIMIT n]'
      );
    }
    const [, colList, tname, where, group, orderCol, dir, limit] = m;
    const t = this.table(tname);
    let preds = [];
    if (where) preds = where.split(/\s+and\s+/i).map(cond);
    const rows = t.rows.filter((r) => preds.every((p) => p(r)));

    const specs = colList.split(',').map((c) => {
      const cm = COL_RE.exec(c.trim());
      if (!cm) throw new Error('Cannot parse column: ' + c.trim());
      const fn = cm[2] ? cm[2].toLowerCase() : null;
      const col = fn ? cm[3] : cm[1];
      const alias = cm[4] || (fn ? (fn === 'count' && col === '*' ? 'count' : `${fn}_${col === '*' ? 'all' : col}`) : col);
      return { fn, col, alias };
    });

    let out;
    if (group || specs.some((s) => s.fn)) {
      const groups = new Map();
      for (const r of rows) {
        const k = group ? r[group] : '_';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      if (!group && !rows.length) groups.set('_', []);
      out = [...groups.entries()].map(([k, rs]) => {
        const o = {};
        for (const s of specs) {
          if (!s.fn) {
            if (s.col === '*') continue;
            o[s.alias] = group && s.col === group ? k : rs[0] ? rs[0][s.col] : null;
          } else o[s.alias] = agg(s.fn, s.col, rs);
        }
        return o;
      });
    } else {
      out = rows.map((r) => {
        const o = {};
        for (const s of specs) {
          if (s.col === '*') Object.assign(o, r);
          else o[s.alias] = r[s.col];
        }
        return o;
      });
    }

    if (orderCol) {
      const sign = dir && dir.toLowerCase() === 'desc' ? -1 : 1;
      out.sort((a, b) => {
        const x = a[orderCol];
        const y = b[orderCol];
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
        return String(x ?? '').localeCompare(String(y ?? '')) * sign;
      });
    }
    const total = out.length;
    out = out.slice(0, Math.min(Number(limit) || 200, 1000));
    const columns = out.length ? Object.keys(out[0]) : specs.filter((s) => s.col !== '*').map((s) => s.alias);
    return { columns, rows: out, total, took_ms: Date.now() - t0 };
  }
}

module.exports = { Database, Table };
