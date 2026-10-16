// Regenerate the shared, integrity-pinned Reader font collection from Google's OFL sources.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

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
    "notoserifkr",
    "notosanskr",
    "sawarabimincho",
    "sawarabigothic",
  ],
  western: [
    "literata",
    "lora",
    "merriweather",
    "sourceserif4",
    "crimsonpro",
    "ebgaramond",
    "inter",
    "opensans",
    "roboto",
    "sourcesans3",
    "nunito",
  ],
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function read(path) {
  const response = await fetch(
    `https://raw.githubusercontent.com/google/fonts/${commit}/ofl/${path}`,
  );
  if (!response.ok) throw Error(`${path}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const fonts = [];
await mkdir("artifacts/font-samples", { recursive: true });
for (const [category, folders] of Object.entries(families)) {
  for (const folder of folders) {
    const metadata = (await read(`${folder}/METADATA.pb`)).toString();
    const family = metadata.match(/^name: "(.+)"/m)[1];
    const familyId = family.toLowerCase().replaceAll(" ", "-");
    const licenseHash = hash(await read(`${folder}/OFL.txt`));
    const axis = [...metadata.matchAll(/axes \{([\s\S]*?)\}/g)]
      .map((m) => m[1])
      .find((a) => a.includes('tag: "wght"'));
    const range = axis
      ? `${axis.match(/min_value: ([\d.]+)/)[1]} ${axis.match(/max_value: ([\d.]+)/)[1]}`
      : null;
    for (const match of metadata.matchAll(/fonts \{([\s\S]*?)\}/g)) {
      const entry = match[1];
      if (!entry.includes('style: "normal"')) continue;
      const filename = entry.match(/filename: "(.+)"/)[1];
      const weight = range ?? entry.match(/weight: (\d+)/)[1];
      const id = range || weight === "400" ? familyId : `${familyId}-${weight}`;
      const bytes = await read(`${folder}/${encodeURIComponent(filename)}`);
      fonts.push({
        id,
        familyId,
        family,
        category,
        weight,
        path: `ofl/${folder}/${encodeURIComponent(filename)}`,
        hash: hash(bytes),
        licenseHash,
        size: bytes.length,
      });
      if (["klee-one", "klee-one-600", "zen-old-mincho", "zen-old-mincho-700", "lora"].includes(id))
        await writeFile(`artifacts/font-samples/${id}.ttf`, bytes);
    }
    console.log(
      `${family}: ${fonts
        .filter((f) => f.familyId === familyId)
        .map((f) => f.weight)
        .join(", ")}`,
    );
  }
}
await writeFile(
  "src/features/reader/googleFontCatalog.json",
  JSON.stringify({ commit, fonts }, null, 2) + "\n",
);
