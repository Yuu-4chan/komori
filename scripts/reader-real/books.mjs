// Synthetic EPUBs for the real-engine Reader smoke test, built in code from random letters and
// numbered markers: S01-S09, S11-S17, a twin of S09 set right to left on its bodies alone, a
// vertical-lr twin of S11 and a left-to-right twin of S16. Every paragraph starts with a marker
// such as [02-005] so a reading point is recognizable.
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A small seeded generator so every run builds the same books. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = random(20261009);
const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (list) => list[Math.floor(rng() * list.length)];
const range = (from, to) =>
  Array.from({ length: to - from }, (_, i) => String.fromCharCode(from + i));
const LATIN = [..."abcdefghijklmnopqrstuvwxyz"];
const KANA = [...range(0x3042, 0x3094), ...range(0x30a2, 0x30f4)];
const KANJI = range(0x4e00, 0x4e00 + 400);
const ARABIC = range(0x0627, 0x064b);
const pad = (n, width) => String(n).padStart(width, "0");

const words = (n, alphabet = LATIN) =>
  Array.from({ length: n }, () =>
    Array.from({ length: between(2, 9) }, () => pick(alphabet)).join(""),
  ).join(" ");
const cjk = (n) =>
  Array.from({ length: n }, () => (rng() < 0.3 ? pick(KANJI) : pick(KANA))).join("") + "。";

// ---------- ZIP ----------
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, store } of entries) {
    const raw = Buffer.from(data);
    const body = store ? raw : deflateRawSync(raw, { level: 9 });
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(store ? 0 : 8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(store ? 0 : 8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, body);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A solid RGB PNG with `bars` dark horizontal bars. */
function png(width, height, rgb, bars) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const dark = Math.floor((y * (2 * bars + 1)) / height) % 2 === 1;
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(dark ? [30, 30, 30] : rgb, 1 + x * 3);
    rows.push(row);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const tagged = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tagged));
    return Buffer.concat([length, tagged, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- EPUB ----------
function xhtml(
  title,
  body,
  { lang = "en", css = [], head = "", htmlAttrs = "", bodyAttrs = "" } = {},
) {
  const links = css.map((c) => `<link rel="stylesheet" type="text/css" href="${c}"/>`).join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"${htmlAttrs}>` +
    `<head><meta charset="utf-8"/><title>${title}</title>${head}${links}</head><body${bodyAttrs}>${body}</body></html>`
  );
}

function nav(entries, lang) {
  const items = entries.map(([href, text]) => `<li><a href="${href}">${text}</a></li>`).join("");
  return xhtml(
    "Contents",
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${items}</ol></nav>`,
    { lang },
  );
}

/**
 * sections: [{ id, href, doc, properties? }], `properties` being the itemref's; files:
 * [{ href, type, data }]; ncx: [[href, text]] for EPUB 2.
 */
function epub(
  name,
  {
    title,
    lang = "en",
    sections,
    navEntries = [],
    meta = "",
    ppd,
    files = [],
    version = "3.0",
    metaInf = [],
    ncx,
  },
) {
  const epub3 = version.startsWith("3");
  const manifest = epub3
    ? ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
    : [];
  for (const { id, href } of sections)
    manifest.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
  files.forEach(({ href, type }, i) =>
    manifest.push(`<item id="f${i}" href="${href}" media-type="${type}"/>`),
  );
  if (ncx) manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  const spineAttributes =
    (ppd ? ` page-progression-direction="${ppd}"` : "") + (ncx ? ' toc="ncx"' : "");
  const itemrefs = sections
    .map(
      ({ id, properties }) =>
        `<itemref idref="${id}"${properties ? ` properties="${properties}"` : ""}/>`,
    )
    .join("");
  const opf =
    `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="uid"` +
    ` prefix="rendition: http://www.idpf.org/vocab/rendition/#">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:reader-real-${name}</dc:identifier>` +
    `<dc:title>${title}</dc:title><dc:language>${lang}</dc:language><dc:creator>Komori reader-real</dc:creator>` +
    `<meta property="dcterms:modified">2026-10-11T00:00:00Z</meta>${meta}</metadata>` +
    `<manifest>${manifest.join("")}</manifest><spine${spineAttributes}>${itemrefs}</spine></package>`;
  const entries = [
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data:
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
    ...metaInf.map(([file, data]) => ({ name: `META-INF/${file}`, data })),
    { name: "OEBPS/content.opf", data: opf },
  ];
  if (epub3) entries.push({ name: "OEBPS/nav.xhtml", data: nav(navEntries, lang) });
  if (ncx) {
    const points = ncx
      .map(
        ([href, text], i) =>
          `<navPoint id="p${i}" playOrder="${i + 1}"><navLabel><text>${text}</text></navLabel><content src="${href}"/></navPoint>`,
      )
      .join("");
    entries.push({
      name: "OEBPS/toc.ncx",
      data: `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>${title}</text></docTitle><navMap>${points}</navMap></ncx>`,
    });
  }
  for (const { href, doc } of sections) entries.push({ name: `OEBPS/${href}`, data: doc });
  for (const { href, data } of files) entries.push({ name: `OEBPS/${href}`, data });
  return { name, title, data: zip(entries) };
}

function textSections(count, paragraphs, { lang = "en", css = [], prefix = "s" } = {}) {
  return Array.from({ length: count }, (_, s) => {
    const body =
      lang === "ja"
        ? `<h1 id="c${s}">〈${pad(s, 2)}〉</h1>` +
          Array.from(
            { length: paragraphs },
            (_, p) =>
              `<p id="p${s}-${p}">〈${pad(s, 2)}-${pad(p, 3)}〉${cjk(between(60, 160))}</p>`,
          ).join("")
        : `<h1 id="c${s}">Part ${s}</h1>` +
          Array.from(
            { length: paragraphs },
            (_, p) =>
              `<p id="p${s}-${p}">[${pad(s, 2)}-${pad(p, 3)}] ${words(between(40, 90))}.</p>`,
          ).join("");
    return {
      id: `${prefix}${s}`,
      href: `${prefix}${s}.xhtml`,
      doc: xhtml(`Part ${s}`, body, { lang, css }),
    };
  });
}

const navOf = (sections) => sections.map(({ href }, i) => [href, `Part ${i}`]);

/** Every smoke-test book, keyed by a short name. */
export function buildBooks() {
  const books = [];
  // S01/S02: fixed layout, EPUB 3 pre-paginated and the legacy iBooks declaration.
  const fxlCss =
    "html,body{margin:0;padding:0}body{width:1200px;height:1600px;position:relative;font-size:1.5em;line-height:1.4;" +
    "font-weight:400;text-indent:0}.box{position:absolute;left:100px;width:1000px}.b1{top:120px;font-size:2rem}" +
    ".b2{top:420px;font-size:1em;text-indent:2em}.b3{top:1250px;font-weight:700}svg{position:absolute;left:0;top:700px}";
  const fxlPages = Array.from({ length: 8 }, (_, i) => {
    const art =
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect x="100" y="0" width="1000" height="500" ` +
      `fill="#${pad(((i * 37) % 256).toString(16), 2)}${pad(((i * 91) % 256).toString(16), 2)}c0"/><circle cx="600" cy="250" r="${100 + i * 15}" fill="#fff"/></svg>`;
    const body =
      `<div class="box b1">[FXL ${i}] ${words(6)}</div><div class="box b2">${words(60)}</div>${art}` +
      `<div class="box b3">[FXL ${i} end] ${words(8)}</div>`;
    return {
      id: `pg${i}`,
      href: `pg${i}.xhtml`,
      doc: xhtml(`Page ${i}`, body, {
        css: ["fxl.css"],
        head: '<meta name="viewport" content="width=1200, height=1600"/>',
      }),
    };
  });
  const fxlFiles = [{ href: "fxl.css", type: "text/css", data: fxlCss }];
  books.push(
    epub("S01-fxl-prepaginated", {
      title: "Reader real S01 fixed layout",
      sections: fxlPages,
      navEntries: [
        ["pg0.xhtml", "Start"],
        ["pg4.xhtml", "Middle"],
      ],
      meta:
        '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">auto</meta>' +
        '<meta property="rendition:orientation">auto</meta>',
      files: fxlFiles,
    }),
    epub("S02-fxl-legacy-ibooks", {
      title: "Reader real S02 legacy fixed",
      sections: fxlPages,
      version: "2.0",
      ncx: [
        ["pg0.xhtml", "Start"],
        ["pg4.xhtml", "Middle"],
      ],
      metaInf: [
        [
          "com.apple.ibooks.display-options.xml",
          '<?xml version="1.0" encoding="UTF-8"?><display_options><platform name="*">' +
            '<option name="fixed-layout">true</option></platform></display_options>',
        ],
      ],
      files: fxlFiles,
    }),
  );
  // S03-S05: authored rendition:flow.
  for (const [id, flow] of [
    ["S03", "scrolled-doc"],
    ["S04", "scrolled-continuous"],
    ["S05", "paginated"],
  ]) {
    const sections = textSections(6, 30);
    books.push(
      epub(`${id}-flow-${flow}`, {
        title: `Reader real ${id} flow ${flow}`,
        sections,
        navEntries: navOf(sections),
        meta: `<meta property="rendition:flow">${flow}</meta>`,
      }),
    );
  }
  // S06: two independently linked, mutually importing stylesheets; section 2 links them
  // in the other order.
  const cycle = textSections(4, 25, { css: ["a.css", "b.css"] });
  cycle[2].doc = cycle[2].doc
    .replace('href="a.css"', 'href="TMP"')
    .replace('href="b.css"', 'href="a.css"')
    .replace('href="TMP"', 'href="b.css"');
  books.push(
    epub("S06-css-two-root-cycle", {
      title: "Reader real S06 import cycle",
      sections: cycle,
      navEntries: navOf(cycle),
      files: [
        {
          href: "a.css",
          type: "text/css",
          data: '@import url("b.css");\np{font-weight:700;margin:0 0 .5em}',
        },
        { href: "b.css", type: "text/css", data: '@import url("a.css");\nh1{font-weight:900}' },
      ],
    }),
  );
  // S07: a section ending in page-size images, an image-only section, then text.
  const colors = [
    [200, 60, 60],
    [60, 160, 60],
    [60, 60, 200],
    [200, 180, 40],
    [150, 60, 180],
    [40, 170, 170],
  ];
  const images = colors.map((rgb, i) => ({
    href: `im${i}.png`,
    type: "image/png",
    data: png(600, 900, rgb, i + 1),
  }));
  const img = (i) => `<img class="page" src="im${i}.png" alt="${i}"/>`;
  const imageBook = [
    ...textSections(1, 20),
    {
      id: "m1",
      href: "m1.xhtml",
      doc: xhtml(
        "Trailing art",
        `<p id="t1">[01-000] ${words(30)}.</p>${img(0)}${img(1)}${img(2)}`,
        {
          css: ["img.css"],
        },
      ),
    },
    {
      id: "m2",
      href: "m2.xhtml",
      doc: xhtml("Image only", `${img(3)}${img(4)}${img(5)}`, { css: ["img.css"] }),
    },
    ...textSections(1, 20, { prefix: "e" }),
  ];
  books.push(
    epub("S07-adjacent-images", {
      title: "Reader real S07 adjacent images",
      sections: imageBook,
      navEntries: [
        ["s0.xhtml", "Start"],
        ["m1.xhtml", "Trailing art"],
        ["m2.xhtml", "Image only"],
        ["e0.xhtml", "End"],
      ],
      files: [
        ...images,
        {
          href: "img.css",
          type: "text/css",
          data: "img.page{display:block;width:auto;height:95vh;margin:0 auto}",
        },
      ],
    }),
  );
  // S08: TOC fragments missing in valid linear documents: all missing, then mixed.
  books.push(
    epub("S08a-toc-missing-fragment", {
      title: "Reader real S08a missing fragment",
      sections: textSections(3, 40),
      navEntries: [["s0.xhtml#missing", "Only entry"]],
    }),
    epub("S08b-toc-mixed-fragments", {
      title: "Reader real S08b mixed fragments",
      sections: textSections(3, 40),
      navEntries: [
        ["s0.xhtml#c0", "Part 0"],
        ["s1.xhtml#missing", "Part 1"],
        ["s2.xhtml#c2", "Part 2"],
      ],
    }),
  );
  // S09: right-to-left script whose documents set dir="rtl" themselves.
  const rtl = Array.from({ length: 6 }, (_, i) => ({
    id: `s${i}`,
    href: `s${i}.xhtml`,
    doc: xhtml(
      `${i}`,
      `<h1 id="c${i}">${i}</h1>` +
        Array.from(
          { length: 30 },
          (_, p) => `<p>[${pad(i, 2)}-${pad(p, 3)}] ${words(between(40, 80), ARABIC)}.</p>`,
        ).join(""),
      { lang: "ar", htmlAttrs: ' dir="rtl"' },
    ),
  }));
  books.push(
    epub("S09-rtl-arabic-script", {
      title: "Reader real S09 rtl",
      lang: "ar",
      ppd: "rtl",
      sections: rtl,
      navEntries: rtl.map(({ href }, i) => [href, `${i}`]),
    }),
  );
  // S09b: the same script set right to left on each body alone, in a left-to-right book.
  const rtlBodies = Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`,
    href: `s${i}.xhtml`,
    doc: xhtml(
      `${i}`,
      `<h1 id="c${i}">${i}</h1>` +
        Array.from(
          { length: 90 },
          (_, p) => `<p>[${pad(i, 2)}-${pad(p, 3)}] ${words(between(40, 80), ARABIC)}.</p>`,
        ).join(""),
      { lang: "he", bodyAttrs: ' style="text-align:right" dir="rtl"' },
    ),
  }));
  books.push(
    epub("S09b-rtl-bodies", {
      title: "Reader real S09b rtl bodies",
      lang: "he",
      sections: rtlBodies,
      navEntries: rtlBodies.map(({ href }, i) => [href, `${i}`]),
    }),
  );
  // S11: declared vertical-rl marker book, and its vertical-lr twin.
  for (const [name, mode, ppd] of [
    ["S11-vertical-rl-markers", "vertical-rl", "rtl"],
    ["S11lr-vertical-lr-markers", "vertical-lr", undefined],
  ]) {
    const sections = textSections(12, 60, { lang: "ja" });
    books.push(
      epub(name, {
        title: `Reader real ${name}`,
        lang: "ja",
        ppd,
        sections,
        navEntries: sections.map(({ href }, i) => [href, `〈${pad(i, 2)}〉`]),
        meta: `<meta name="primary-writing-mode" content="${mode}"/>`,
      }),
    );
  }
  // S12: landscape two-page spreads larger than the window, shaped as two volumes of one
  // light novel series ship them: an image in a paragraph after blank ones, with no stylesheet
  // or head, and a pre-paginated page in the reflowable book whose SVG fills the page.
  const spread = {
    href: "spread.png",
    type: "image/png",
    data: png(2048, 1453, [70, 120, 190], 6),
  };
  const blank = "<p>  \n</p>".repeat(3);
  const spreads = [
    ...textSections(1, 20, { lang: "ja" }),
    {
      id: "w1",
      href: "w1.xhtml",
      doc:
        `<?xml version='1.0' encoding='utf-8'?>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">` +
        `<head/><body>${blank}<p>  <span id="#pagestart"></span><img src="spread.png" alt="spread"/>\n</p></body></html>`,
    },
    {
      id: "w2",
      href: "w2.xhtml",
      properties:
        "rendition:layout-pre-paginated rendition:spread-none rendition:page-spread-center",
      doc: xhtml(
        "Spread",
        `<div class="main"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 2048 1453" aria-label="spread">` +
          `<image width="2048" height="1453" xlink:href="spread.png"/></svg></div>`,
        {
          lang: "ja",
          css: ["fixed.css"],
          head: '<meta name="viewport" content="width=2048, height=1453"/>',
        },
      ),
    },
    ...textSections(1, 20, { lang: "ja", prefix: "e" }),
  ];
  books.push(
    epub("S12-wide-spreads", {
      title: "Reader real S12 wide spreads",
      lang: "ja",
      sections: spreads,
      navEntries: [
        ["s0.xhtml", "Start"],
        ["w1.xhtml", "Spread"],
        ["w2.xhtml", "Fixed spread"],
        ["e0.xhtml", "End"],
      ],
      files: [spread, { href: "fixed.css", type: "text/css", data: "" }],
      meta: '<meta name="primary-writing-mode" content="horizontal-lr"/>',
    }),
  );
  // S13: a vertical book whose stylesheet forces its bodies vertical through a class on the root,
  // as some Japanese conversions do, so that only a cascade layer outranks it.
  const forced = textSections(4, 120, { lang: "ja", css: ["forced.css"] }).map((section) => ({
    ...section,
    doc: section.doc.replace('<html xmlns="', '<html class="vrtl" xmlns="'),
  }));
  books.push(
    epub("S13-forced-vertical", {
      title: "Reader real S13 forced vertical",
      lang: "ja",
      ppd: "rtl",
      sections: forced,
      navEntries: forced.map(({ href }, i) => [href, `〈${pad(i, 2)}〉`]),
      files: [
        {
          href: "forced.css",
          type: "text/css",
          data:
            "html.vrtl { writing-mode: vertical-rl; -webkit-writing-mode: vertical-rl; }\n" +
            "html.vrtl body { writing-mode: vertical-rl !important; -webkit-writing-mode: vertical-rl !important; }",
        },
      ],
      meta: '<meta name="primary-writing-mode" content="vertical-rl"/>',
    }),
  );
  // S14: assets named by paths other than their relative ones, as calibre conversions write
  // them: through the package folder's own name, with "./", and from a stylesheet's folder.
  const picture = (rgb) => png(320, 480, rgb, 4);
  books.push(
    epub("S14-asset-spellings", {
      title: "Reader real S14 asset spellings",
      sections: [
        {
          id: "s0",
          href: "Text/s0.xhtml",
          doc: xhtml(
            "Pictures",
            `<h1 id="c0">Pictures</h1><p>[00-000] ${words(30)}.</p>` +
              '<p><img src="../../OEBPS/Images/a.png" alt="a"/></p>' +
              '<p><img src="./../Images/b.png" alt="b"/></p>' +
              '<div class="framed"></div>',
            { css: ["../../OEBPS/Styles/style.css"] },
          ),
        },
      ],
      navEntries: [["Text/s0.xhtml", "Pictures"]],
      files: [
        { href: "Images/a.png", type: "image/png", data: picture([200, 80, 60]) },
        { href: "Images/b.png", type: "image/png", data: picture([60, 160, 90]) },
        { href: "Images/c.png", type: "image/png", data: picture([60, 90, 200]) },
        {
          href: "Styles/style.css",
          type: "text/css",
          data: ".framed { width: 64px; height: 96px; background: url(../../OEBPS/Images/c.png) center / contain no-repeat; }",
        },
      ],
    }),
  );
  // S15: an EPUB 3 book whose navigation document is an editor's placeholder, naming a file the
  // book lacks, while its NCX lists every chapter.
  const placeholder = textSections(3, 20);
  books.push(
    epub("S15-placeholder-nav", {
      title: "Reader real S15 placeholder nav",
      sections: placeholder,
      navEntries: [["Section0001.xhtml", "Start"]],
      ncx: navOf(placeholder),
    }),
  );
  // S16: a right-to-left fixed-layout book whose pages declare their sides of a spread, the
  // cover alone on the left, and its left-to-right twin with the cover alone on the right.
  for (const [name, ppd, sides] of [
    ["S16-fxl-rtl-spreads", "rtl", ["left", "right"]],
    ["S16lr-fxl-ltr-spreads", "ltr", ["right", "left"]],
  ]) {
    const pages = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      href: `p${i}.xhtml`,
      properties: `page-spread-${sides[i % 2]}`,
      doc: xhtml(
        `Page ${i}`,
        `<div class="page" style="background:#${pad(((i * 53) % 200).toString(16), 2)}80c0">` +
          `<p>[16-${pad(i, 3)}] ${words(12)}</p></div>`,
        {
          css: ["page.css"],
          head: '<meta name="viewport" content="width=600, height=900"/>',
        },
      ),
    }));
    books.push(
      epub(name, {
        title: `Reader real ${name.split("-")[0]} fixed-layout spreads`,
        sections: pages,
        navEntries: pages.map(({ href }, i) => [href, `Page ${i}`]),
        ppd,
        meta:
          '<meta property="rendition:layout">pre-paginated</meta>' +
          '<meta property="rendition:spread">landscape</meta>',
        files: [
          {
            href: "page.css",
            type: "text/css",
            data:
              "html,body{margin:0;padding:0}body{width:600px;height:900px}" +
              ".page{width:600px;height:900px;overflow:hidden}p{margin:0;padding:60px;font-size:40px}",
          },
        ],
      }),
    );
  }
  // S17: more sections than WebView2 loads frames in a page, the first chapter alone holding
  // 1000 of them and the others 50.
  const many = textSections(1100, 2);
  books.push(
    epub("S17-many-sections", {
      title: "Reader real S17 many sections",
      sections: many,
      navEntries: navOf(many).filter((_, i) => i === 0 || (i >= 1000 && i % 50 === 0)),
    }),
  );
  return books;
}

/** Writes every book into `folder` and returns their names and paths. */
export function writeBooks(folder) {
  mkdirSync(folder, { recursive: true });
  return buildBooks().map(({ name, title, data }) => {
    const path = join(folder, `${name}.epub`);
    writeFileSync(path, data);
    return { name, title, path };
  });
}

/** A book for the Library drop check, outside the scanned folder, and a text file beside it. */
export function writeDropFiles(folder) {
  mkdirSync(folder, { recursive: true });
  const sections = textSections(2, 6, { prefix: "d" });
  const { title, data } = epub("D01-dropped", {
    title: "Reader real D01 dropped",
    sections,
    navEntries: navOf(sections),
  });
  const book = join(folder, "D01-dropped.epub");
  const text = join(folder, "D01-notes.txt");
  writeFileSync(book, data);
  writeFileSync(text, "Not a book.\n");
  return { title, book, text };
}
