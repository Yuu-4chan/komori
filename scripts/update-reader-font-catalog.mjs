// Regenerate the shared, integrity-pinned Reader font collection from Google's OFL sources.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const commit = "9710da1eacb3be272583c3224dcb70f9da6eadbb";
const families = {
  asian: [
    "zenoldmincho",
    "zenkakugothicnew",
    "kleeone",
    "shipporimincho",
    "shipporiminchob1",
    "notoserifjp",
    "notosansjp",
    "notoserifsc",
    "notosanssc",
    "notoseriftc",
    "notosanstc",
    "notoserifhk",
    "notosanshk",
    "notoserifkr",
    "notosanskr",
    "sawarabimincho",
    "sawarabigothic",
    "bizudpmincho",
    "bizudpgothic",
    "bizudmincho",
    "bizudgothic",
    "hinamincho",
    "kaiseiopti",
    "kaiseitokumin",
    "shipporiantique",
    "zenkakugothicantique",
    "zenmarugothic",
    "zenkurenaido",
    "zenantique",
    "kiwimaru",
    "mplus1p",
    "mplusrounded1c",
    "murecho",
    "ibmplexsansjp",
    "yujisyuku",
    "yomogi",
    "lxgwwenkaitc",
    "zcoolxiaowei",
    "mashanzheng",
    "nanummyeongjo",
    "nanumgothic",
    "gowunbatang",
    "gowundodum",
    "hahmlet",
    "songmyung",
    "ibmplexsanskr",
  ],
  western: [
    "literata",
    "lora",
    "merriweather",
    "sourceserif4",
    "crimsonpro",
    "crimsontext",
    "ebgaramond",
    "cormorantgaramond",
    "librebaskerville",
    "alegreya",
    "spectral",
    "newsreader",
    "vollkorn",
    "cardo",
    "gentiumbookplus",
    "ptserif",
    "notoserif",
    "ibmplexserif",
    "bitter",
    "zillaslab",
    "andadapro",
    "besley",
    "petrona",
    "fraunces",
    "oldstandardtt",
    "inter",
    "opensans",
    "roboto",
    "sourcesans3",
    "nunito",
    "notosans",
    "ptsans",
    "lato",
    "alegreyasans",
    "ibmplexsans",
    "atkinsonhyperlegiblenext",
    "lexend",
    "worksans",
    "firasans",
    "karla",
    "manrope",
    "librefranklin",
    "publicsans",
    "mulish",
    "quicksand",
    "montserrat",
    "raleway",
    "dmsans",
  ],
};
// Komori's installer includes these files, so they are available without a download.
const bundled = ["zen-old-mincho", "noto-sans-jp", "noto-sans-sc", "noto-sans-kr", "klee-one"];
const MAX_BYTES = 32 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function read(path, optional = false) {
  const response = await fetch(
    `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/${path}`,
  );
  if (optional && response.status === 404) return null;
  if (!response.ok) throw Error(`${path}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const fonts = [];
for (const [category, folders] of Object.entries(families)) {
  for (const folder of folders) {
    const metadata = (await read(`${folder}/METADATA.pb`)).toString();
    const family = metadata.match(/^name: "(.+)"/m)[1];
    const familyId = family.toLowerCase().replaceAll(" ", "-");
    // Komori fetches each font's license from beside it, as OFL.txt.
    const license = await read(`${folder}/OFL.txt`, true);
    if (!license) {
      console.warn(`${family}: no OFL.txt, skipped`);
      continue;
    }
    if (license.length > 16384) throw Error(`${family}: the license is over its size limit`);
    const licenseHash = hash(license);
    const axis = [...metadata.matchAll(/axes \{([\s\S]*?)\}/g)]
      .map((m) => m[1])
      .find((a) => a.includes('tag: "wght"'));
    const range = axis
      ? `${axis.match(/min_value: ([\d.]+)/)[1]} ${axis.match(/max_value: ([\d.]+)/)[1]}`
      : null;
    const files = [];
    for (const match of metadata.matchAll(/fonts \{([\s\S]*?)\}/g)) {
      const entry = match[1];
      if (!entry.includes('style: "normal"')) continue;
      const filename = entry.match(/filename: "(.+)"/)[1];
      const weight = range ?? entry.match(/weight: (\d+)/)[1];
      const id = range || weight === "400" ? familyId : `${familyId}-${weight}`;
      if (files.some((f) => f.id === id)) continue;
      const bytes = await read(`${folder}/${encodeURIComponent(filename)}`);
      if (bytes.length > MAX_BYTES) {
        console.warn(`${family} ${weight}: ${bytes.length} bytes is over the size limit, skipped`);
        continue;
      }
      files.push({
        id,
        familyId,
        family,
        category,
        weight,
        path: `ofl/${folder}/${encodeURIComponent(filename)}`,
        hash: hash(bytes),
        licenseHash,
        size: bytes.length,
        ...(bundled.includes(id) ? { bundled: true } : {}),
      });
    }
    // A family is offered only with a regular (or variable) file to show by default.
    if (!files.some((f) => f.id === familyId)) {
      console.warn(`${family}: no regular file, skipped`);
      continue;
    }
    fonts.push(...files);
    console.log(`${family}: ${files.map((f) => f.weight).join(", ")}`);
  }
}
for (const id of bundled)
  if (!fonts.some((f) => f.id === id)) throw Error(`The included font ${id} is missing`);
await writeFile(
  "src/features/reader/googleFontCatalog.json",
  JSON.stringify({ commit, fonts }, null, 2) + "\n",
);
