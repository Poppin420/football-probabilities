// Tiny RFC-4180-ish CSV parser (quotes, CRLF, BOM, ragged rows).

export class SourceFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceFormatError';
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Header lookup by lower-cased name. Returns a function name -> index (-1 if absent). */
export function headerIndex(headerRow) {
  const names = headerRow.map((h) => h.trim().toLowerCase());
  return (name) => names.indexOf(name.toLowerCase());
}
