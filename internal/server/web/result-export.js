(function initializeResultExport(root, factory) {
  const api = factory();
  root.ResultExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createResultExport() {
  const formats = {
    CSVWithNames: {extension: 'csv', mime: 'text/csv;charset=utf-8'},
    TabSeparatedWithNames: {extension: 'tsv', mime: 'text/tab-separated-values;charset=utf-8'},
    JSONEachRow: {extension: 'jsonl', mime: 'application/x-ndjson;charset=utf-8'},
    JSON: {extension: 'json', mime: 'application/json;charset=utf-8'}
  };

  function cellValue(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'object') return JSON.stringify(input);
    return String(input);
  }

  function csvCell(input) {
    const text = cellValue(input);
    if (text === null) return '';
    return `"${text.replace(/"/g, '""')}"`;
  }

  function tsvCell(input) {
    const text = cellValue(input);
    if (text === null) return '\\N';
    return text.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\f/g, '\\f');
  }

  function orderedRow(row, meta) {
    return Object.fromEntries(meta.map(column => [column.name, row[column.name] ?? null]));
  }

  function serialize(result, format) {
    const meta = result.meta || [];
    const data = result.data || [];
    if (format === 'CSVWithNames') {
      return [meta.map(column => csvCell(column.name)).join(','), ...data.map(row => meta.map(column => csvCell(row[column.name])).join(','))].join('\n') + '\n';
    }
    if (format === 'TabSeparatedWithNames') {
      return [meta.map(column => tsvCell(column.name)).join('\t'), ...data.map(row => meta.map(column => tsvCell(row[column.name])).join('\t'))].join('\n') + '\n';
    }
    if (format === 'JSONEachRow') return data.map(row => JSON.stringify(orderedRow(row, meta))).join('\n') + (data.length ? '\n' : '');
    if (format !== 'JSON') throw new Error(`unsupported export format: ${format}`);
    const output = {meta, data: data.map(row => orderedRow(row, meta)), rows: data.length};
    if (result.statistics !== undefined) output.statistics = result.statistics;
    return JSON.stringify(output, null, 2) + '\n';
  }

  function safeName(input) {
    return String(input || 'cluster').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'cluster';
  }

  return Object.freeze({formats: Object.freeze(formats), safeName, serialize});
});
