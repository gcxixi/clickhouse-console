const assert = require('node:assert/strict');
const test = require('node:test');
const {safeName, serialize} = require('./result-export.js');

const sample = {
  meta: [
    {name: 'text', type: 'String'},
    {name: 'multiline', type: 'String'},
    {name: 'nullable', type: 'Nullable(String)'},
    {name: 'arr', type: 'Array(UInt8)'},
    {name: 'n', type: 'UInt64'}
  ],
  data: [{text: 'a,b"c', multiline: 'line\nnext', nullable: null, arr: [1, 2], n: '42'}],
  statistics: {elapsed: 0.01}
};

test('serializes CSVWithNames with quoted headers, embedded quotes, newlines, nested values, and NULL', () => {
  assert.equal(
    serialize(sample, 'CSVWithNames'),
    '"text","multiline","nullable","arr","n"\n"a,b""c","line\nnext",,"[1,2]","42"\n'
  );
});

test('serializes TabSeparatedWithNames with ClickHouse-style escaping and NULL', () => {
  assert.equal(
    serialize(sample, 'TabSeparatedWithNames'),
    'text\tmultiline\tnullable\tarr\tn\na,b"c\tline\\nnext\t\\N\t[1,2]\t42\n'
  );
});

test('serializes JSONEachRow in metadata column order', () => {
  assert.equal(
    serialize(sample, 'JSONEachRow'),
    '{"text":"a,b\\"c","multiline":"line\\nnext","nullable":null,"arr":[1,2],"n":"42"}\n'
  );
});

test('serializes JSON with metadata, rows, and statistics', () => {
  assert.deepEqual(JSON.parse(serialize(sample, 'JSON')), {
    meta: sample.meta,
    data: sample.data,
    rows: 1,
    statistics: sample.statistics
  });
});

test('exports an empty result with headers and produces safe filenames', () => {
  const empty = {meta: sample.meta, data: []};
  assert.equal(serialize(empty, 'CSVWithNames'), '"text","multiline","nullable","arr","n"\n');
  assert.equal(serialize(empty, 'JSONEachRow'), '');
  assert.equal(safeName('prod / 华东'), 'prod');
  assert.equal(safeName(''), 'cluster');
});

test('rejects unsupported export formats', () => {
  assert.throws(() => serialize(sample, 'Parquet'), /unsupported export format/);
});
