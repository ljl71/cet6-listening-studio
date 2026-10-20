import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0;
});
export function crc32(buffer, previous = 0) {
  let crc = previous ^ 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function prepare(entry) {
  const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
  if (name.length > 65535 || /(^\/|(^|\/)\.\.(\/|$))/.test(entry.name)) throw new Error('备份路径无效');
  let size, crc = 0;
  if (entry.data) { size = entry.data.length; crc = crc32(entry.data); }
  else { size = (await stat(entry.path)).size; for await (const chunk of createReadStream(entry.path)) crc = crc32(chunk, crc); }
  if (size >= 0xffffffff) throw new Error('单个备份文件过大');
  return { ...entry, name, size, crc };
}

export async function writeZip(response, entries) {
  if (entries.length > 65535) throw new Error('备份文件数量过多');
  const prepared = [];
  for (const entry of entries) prepared.push(await prepare(entry));
  let predicted = 22;
  for (const entry of prepared) predicted += 30 + entry.name.length + entry.size + 46 + entry.name.length;
  if (predicted >= 0xffffffff) throw new Error('备份超过 ZIP 4 GB 限制');
  response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="cet6-complete-backup.zip"', 'Content-Length': predicted, 'Cache-Control': 'no-store' });
  let offset = 0;
  const central = [];
  const write = async buffer => { if (!response.write(buffer)) await once(response, 'drain'); offset += buffer.length; };
  for (const entry of prepared) {
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(entry.crc, 14); local.writeUInt32LE(entry.size, 18); local.writeUInt32LE(entry.size, 22); local.writeUInt16LE(entry.name.length, 26);
    await write(local); await write(entry.name);
    if (entry.data) await write(entry.data); else for await (const chunk of createReadStream(entry.path)) await write(chunk);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8);
    header.writeUInt32LE(entry.crc, 16); header.writeUInt32LE(entry.size, 20); header.writeUInt32LE(entry.size, 24); header.writeUInt16LE(entry.name.length, 28); header.writeUInt32LE(localOffset, 42);
    central.push(header, entry.name);
  }
  const centralStart = offset;
  for (const block of central) await write(block);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(prepared.length, 8); end.writeUInt16LE(prepared.length, 10); end.writeUInt32LE(offset - centralStart, 12); end.writeUInt32LE(centralStart, 16);
  await write(end); response.end();
}
