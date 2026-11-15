importScripts('./vendor/sheetjs-0.20.3.min.js');

const csvEncoding = (bytes) => {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
};

let data, textFile;
self.onmessage = async ({ data: { file, sheet, request } }) => {
  let sheets, name;
  try {
    if (file) {
      textFile = /\.csv$/i.test(file.name);
      const bytes = new Uint8Array(await file.arrayBuffer());
      data = textFile ? csvEncoding(bytes) : bytes;
    }
    const options = { cellHTML: false, cellFormula: false, cellDates: true, dense: true, sheetRows: 10002 };
    if (textFile) Object.assign(options, { type: 'string', raw: true });
    sheets = textFile ? ['CSV'] : XLSX.read(data, { bookSheets: true }).SheetNames;
    name = sheet ?? sheets[0];
    const workbook = XLSX.read(data, textFile ? options : { ...options, sheets: name });
    const actualName = textFile ? workbook.SheetNames[0] : name;
    const selected = workbook.Sheets[actualName];
    if (!selected?.['!ref']) throw new Error('Лист пуст. Выберите лист с таблицей.');
    const range = XLSX.utils.decode_range(selected['!ref']);
    if (range.e.r - range.s.r > 10000 || range.e.c - range.s.c >= 120) {
      throw new Error('Лист должен содержать не более 10 000 строк данных и 120 столбцов.');
    }
    const rows = XLSX.utils.sheet_to_json(selected, { header: 1, raw: true, defval: null, blankrows: false });
    if (rows.length < 2) throw new Error('Нужны заголовки в первой строке и хотя бы одна строка данных.');
    self.postMessage({ request, sheets, name, rows });
  } catch (error) {
    self.postMessage({ request, sheets, name, error: error.message || 'Не удалось прочитать файл.' });
  }
};
