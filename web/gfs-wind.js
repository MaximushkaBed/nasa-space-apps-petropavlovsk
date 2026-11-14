// NOAA GFS 1° analysis, GRIB2 templates 3.0 and 5.3. Only the two 10 m wind messages are downloaded.
const root = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
export const windArchiveStart = '2021-03-23';
const columns = 360;
const rows = 181;

function signedMagnitude(view, offset, bytes) {
  const first = view.getUint8(offset);
  let value = first & 127;
  for (let i = 1; i < bytes; i++) value = value * 256 + view.getUint8(offset + i);
  return first & 128 ? -value : value;
}

function packedValues(grid, packing, bitmap, data) {
  if (grid.getUint16(12) !== 0 || grid.getUint32(30) !== columns || grid.getUint32(34) !== rows
    || grid.getInt32(46) !== 90000000 || grid.getUint32(50) !== 0 || grid.getUint8(71) !== 0
    || packing.getUint16(9) !== 3 || packing.getUint8(22) !== 0 || bitmap.getUint8(5) !== 255) {
    throw new Error('Unsupported NOAA wind grid');
  }
  const count = packing.getUint32(5);
  const groups = packing.getUint32(31);
  const order = packing.getUint8(47);
  const descriptorBytes = packing.getUint8(48);
  if (count !== columns * rows || groups > count || ![1, 2].includes(order) || descriptorBytes < 1 || descriptorBytes > 4) {
    throw new Error('Invalid NOAA wind packing');
  }
  const initial = Array.from({ length: order }, (_, i) => signedMagnitude(data, 5 + i * descriptorBytes, descriptorBytes));
  const minimum = signedMagnitude(data, 5 + order * descriptorBytes, descriptorBytes);
  let bit = 8 * (5 + (order + 1) * descriptorBytes);
  function read(width) {
    if (width > 32 || bit + width > data.byteLength * 8) throw new Error('Invalid NOAA wind bits');
    let value = 0;
    while (width > 0) {
      const offset = bit % 8;
      const size = Math.min(width, 8 - offset);
      value = value * 2 ** size + ((data.getUint8(Math.floor(bit / 8)) >> (8 - offset - size)) & ((1 << size) - 1));
      width -= size;
      bit += size;
    }
    return value;
  }
  function groupValues(width) {
    const values = Array.from({ length: groups }, () => read(width));
    bit = Math.ceil(bit / 8) * 8;
    return values;
  }
  const references = groupValues(packing.getUint8(19));
  const widths = groupValues(packing.getUint8(36));
  const lengths = groupValues(packing.getUint8(46));
  const widthReference = packing.getUint8(35);
  const lengthReference = packing.getUint32(37);
  const lengthStep = packing.getUint8(41);
  const lastLength = packing.getUint32(42);
  const scale = 2 ** signedMagnitude(packing, 15, 2);
  const decimal = 10 ** -signedMagnitude(packing, 17, 2);
  const reference = packing.getFloat32(11);
  const values = new Float32Array(count);
  let i = 0, last = 0, previous = 0;
  for (let g = 0; g < groups; g++) {
    const length = g === groups - 1 ? lastLength : lengthReference + lengths[g] * lengthStep;
    const width = widthReference + widths[g];
    if (i + length > count) throw new Error('Invalid NOAA wind group length');
    for (let j = 0; j < length; j++, i++) {
      const residual = references[g] + read(width) + minimum;
      const value = i < order ? initial[i] : residual + (order === 1 ? last : 2 * last - previous);
      values[i] = (reference + value * scale) * decimal;
      previous = last;
      last = value;
    }
  }
  if (i !== count || values.some((value) => !Number.isFinite(value) || Math.abs(value) > 200)) throw new Error('Invalid NOAA wind values');
  return values;
}

export function decodeWind(buffer) {
  const view = new DataView(buffer);
  const components = new Map();
  for (let start = 0; start < view.byteLength;) {
    if (view.getUint32(start) !== 0x47524942 || view.getUint8(start + 7) !== 2) throw new Error('Invalid NOAA wind message');
    const end = start + Number(view.getBigUint64(start + 8));
    if (end <= start + 16 || end > view.byteLength) throw new Error('Truncated NOAA wind message');
    const sections = new Map();
    for (let offset = start + 16; offset < end - 4;) {
      const length = view.getUint32(offset);
      if (length < 5 || offset + length > end - 4) throw new Error('Truncated NOAA wind section');
      sections.set(view.getUint8(offset + 4), new DataView(buffer, offset, length));
      offset += length;
    }
    const product = sections.get(4);
    const parameter = product.getUint8(10);
    if (product.getUint8(9) !== 2 || ![2, 3].includes(parameter) || product.getUint8(22) !== 103
      || product.getUint32(24) !== 10) throw new Error('Unexpected NOAA wind parameter');
    components.set(parameter, packedValues(...[3, 5, 6, 7].map((number) => sections.get(number))));
    start = end;
  }
  if (components.size !== 2) throw new Error('Missing NOAA wind component');
  return { u: components.get(2), v: components.get(3) };
}

export async function loadGfsWind(day, signal) {
  const path = `${root}/gfs.${day.replaceAll('-', '')}/00/atmos/gfs.t00z.pgrb2.1p00.f000`;
  const index = await fetch(`${path}.idx`, { signal });
  if (index.status === 404) return null;
  if (!index.ok) throw new Error(`NOAA GFS · HTTP ${index.status}`);
  const lines = (await index.text()).trim().split('\n');
  const u = lines.findIndex((line) => line.includes(':UGRD:10 m above ground:'));
  if (u < 0 || !lines[u + 1]?.includes(':VGRD:10 m above ground:') || !lines[u + 2]) throw new Error('Missing NOAA wind index');
  const start = Number(lines[u].split(':')[1]);
  const end = Number(lines[u + 2].split(':')[1]) - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 1000000) {
    throw new Error('Invalid NOAA wind byte range');
  }
  const response = await fetch(path, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (response.status !== 206) throw new Error(`NOAA GFS · HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== end - start + 1) throw new Error('Truncated NOAA wind download');
  return { ...decodeWind(bytes), day };
}

export function sampleWind({ u, v }, lat, lon) {
  const col = ((lon % 360) + 360) % 360;
  const row = Math.min(179.999, Math.max(0, 90 - lat));
  const i = Math.floor(col), j = Math.floor(row);
  const x = col - i, y = row - j;
  const left = j * columns + i;
  const right = j * columns + (i + 1) % columns;
  const between = (values) => (values[left] * (1 - x) + values[right] * x) * (1 - y)
    + (values[left + columns] * (1 - x) + values[right + columns] * x) * y;
  return [between(u), between(v)];
}
