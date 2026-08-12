/*
 * zipwriter.js — a minimal, dependency-free ZIP builder.
 *
 * Entries are STOREd rather than deflated: photos and videos are already
 * compressed, so deflate would burn CPU for nothing, and the text files are a
 * rounding error next to them.
 *
 * Nothing is held in memory as bytes. Each entry keeps its original Blob and
 * only its CRC is computed, by streaming the blob in chunks. The archive is
 * assembled at the end as `new Blob([...headers, ...blobs])`, which Chrome
 * backs with its own storage and spills to disk — so a multi-gigabyte archive
 * does not have to fit in RAM.
 *
 * ZIP64 fields are emitted per entry and for the directory whenever a size,
 * offset or count outgrows the classic 32-bit/16-bit limits.
 */
(function () {
  'use strict';
  if (globalThis.LISZip) return;

  const U32 = 0xffffffff;
  const U16 = 0xffff;

  /* ---------------- CRC32 ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32Update(crc, bytes) {
    let c = crc ^ U32;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ U32) >>> 0;
  }

  /* ---------------- little-endian writer ---------------- */
  class Buf {
    constructor(size) {
      this.b = new Uint8Array(size);
      this.v = new DataView(this.b.buffer);
      this.p = 0;
    }
    u16(n) { this.v.setUint16(this.p, n & U16, true); this.p += 2; return this; }
    u32(n) { this.v.setUint32(this.p, n >>> 0, true); this.p += 4; return this; }
    u64(n) { this.v.setBigUint64(this.p, BigInt(n), true); this.p += 8; return this; }
    raw(u8) { this.b.set(u8, this.p); this.p += u8.length; return this; }
    done() { return this.b; }
  }

  const enc = new TextEncoder();

  /** MS-DOS date/time, which is what the ZIP format stores. */
  function dosTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  /** Strips anything that would make an entry unsafe or unopenable. */
  function safePath(path) {
    return String(path)
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => seg.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+$/, '_'))
      .filter((seg) => seg.length > 0)
      .join('/');
  }

  class ZipWriter {
    constructor() {
      this.parts = [];    // Uint8Array headers interleaved with Blob payloads
      this.entries = [];
      this.offset = 0;    // running byte offset into the archive
      this.bytes = 0;     // total payload bytes added
    }

    get count() { return this.entries.length; }

    /** Streams the blob once to CRC it, then queues it without buffering. */
    async addBlob(path, blob) {
      const name = enc.encode(safePath(path));
      const size = blob.size;

      let crc = 0;
      const reader = blob.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32Update(crc, value);
      }

      const zip64 = size >= U32 || this.offset >= U32;
      const { time, date } = dosTime(new Date());

      // Local file header (+ ZIP64 extra when the sizes need 64 bits)
      const extraLen = zip64 ? 20 : 0;
      const head = new Buf(30 + name.length + extraLen);
      head.u32(0x04034b50)
        .u16(zip64 ? 45 : 20)
        .u16(0x0800)              // UTF-8 filename
        .u16(0)                   // method: store
        .u16(time).u16(date)
        .u32(crc)
        .u32(zip64 ? U32 : size)  // compressed
        .u32(zip64 ? U32 : size)  // uncompressed
        .u16(name.length)
        .u16(extraLen)
        .raw(name);
      if (zip64) head.u16(0x0001).u16(16).u64(size).u64(size);

      this.parts.push(head.done());
      if (size > 0) this.parts.push(blob);

      this.entries.push({ name, crc, size, offset: this.offset, time, date, zip64 });
      this.offset += head.p + size;
      this.bytes += size;
      return size;
    }

    addText(path, text) {
      return this.addBlob(path, new Blob([text], { type: 'text/plain' }));
    }

    /** Writes the central directory and returns the finished archive. */
    finish(mime) {
      const cdParts = [];
      let cdSize = 0;

      for (const e of this.entries) {
        const needs64 = e.size >= U32 || e.offset >= U32;
        const extraLen = needs64 ? 28 : 0;
        const c = new Buf(46 + e.name.length + extraLen);
        c.u32(0x02014b50)
          .u16(needs64 ? 45 : 20)   // version made by
          .u16(needs64 ? 45 : 20)   // version needed
          .u16(0x0800)
          .u16(0)
          .u16(e.time).u16(e.date)
          .u32(e.crc)
          .u32(needs64 ? U32 : e.size)
          .u32(needs64 ? U32 : e.size)
          .u16(e.name.length)
          .u16(extraLen)
          .u16(0)                   // comment length
          .u16(0)                   // disk number
          .u16(0)                   // internal attrs
          .u32(0)                   // external attrs
          .u32(needs64 ? U32 : e.offset)
          .raw(e.name);
        if (needs64) c.u16(0x0001).u16(24).u64(e.size).u64(e.size).u64(e.offset);
        cdParts.push(c.done());
        cdSize += c.p;
      }

      const cdOffset = this.offset;
      const n = this.entries.length;
      const need64 = n >= U16 || cdSize >= U32 || cdOffset >= U32;

      if (need64) {
        // ZIP64 end of central directory record + locator
        const z = new Buf(56 + 20);
        z.u32(0x06064b50).u64(44)
          .u16(45).u16(45)
          .u32(0).u32(0)
          .u64(n).u64(n)
          .u64(cdSize).u64(cdOffset);
        z.u32(0x07064b50).u32(0).u64(cdOffset + cdSize).u32(1);
        cdParts.push(z.done());
      }

      const eocd = new Buf(22);
      eocd.u32(0x06054b50)
        .u16(0).u16(0)
        .u16(need64 ? U16 : n)
        .u16(need64 ? U16 : n)
        .u32(need64 ? U32 : cdSize)
        .u32(need64 ? U32 : cdOffset)
        .u16(0);
      cdParts.push(eocd.done());

      return new Blob(this.parts.concat(cdParts), { type: mime || 'application/zip' });
    }
  }

  globalThis.LISZip = { ZipWriter, crc32Update, safePath };
})();
