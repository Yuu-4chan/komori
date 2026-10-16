const JOINING_KANA = new Set("ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ");
const MAX_MORAS = 32;

export function readingMoras(reading: string): string[] | null {
  if (!/^[\u3041-\u3096\u30a1-\u30fa\u30fc]+$/u.test(reading)) return null;
  const moras: string[] = [];
  for (const kana of reading) {
    if (JOINING_KANA.has(kana)) {
      if (moras.length === 0 || JOINING_KANA.has(moras[moras.length - 1].slice(-1))) return null;
      moras[moras.length - 1] += kana;
    } else {
      if (kana === "ー" && moras.length === 0) return null;
      moras.push(kana);
    }
    if (moras.length > MAX_MORAS) return null;
  }
  return moras.length ? moras : null;
}

// Nasal morae are conventionally written with a handakuten in place of the dakuten (が → か゚).
// The ring is drawn rather than composed from U+309A, which many fonts do not position.
function withoutDakuten(mora: string) {
  return mora.normalize("NFD").replace("\u3099", "").normalize("NFC");
}

export function PitchContour({
  reading,
  position,
  nasal = [],
  devoice = [],
}: {
  reading: string;
  position: number;
  /** One-based morae pronounced nasally, written with a handakuten as in か゚. */
  nasal?: number[];
  /** One-based devoiced morae, circled with a dashed ring. */
  devoice?: number[];
}) {
  const moras = readingMoras(reading);
  if (!moras || position > moras.length) return null;

  const high = (mora: number) =>
    position === 1 ? mora === 1 : mora > 1 && (position === 0 || mora <= position);
  const y = (mora: number) => (high(mora) ? 5 : 17);
  const points = moras.map((_, index) => `${12 + index * 25},${y(index + 1)}`);
  // The short final segment shows the pitch of the following particle, including
  // a downstep after the last mora when position equals the mora count.
  points.push(`${12 + moras.length * 25},${position === 0 ? 5 : 17}`);
  const width = 24 + moras.length * 25;

  return (
    <svg
      aria-hidden="true"
      className="dictionary-pitch__contour"
      height="36"
      viewBox={`0 0 ${width} 36`}
      width={width}
    >
      <polyline
        fill="none"
        points={points.join(" ")}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      {moras.map((mora, index) => (
        <g key={index}>
          <circle cx={12 + index * 25} cy={y(index + 1)} fill="currentColor" r="2.5" />
          {devoice.includes(index + 1) && (
            <circle
              className="dictionary-pitch__devoice"
              cx={12 + index * 25}
              cy="28"
              fill="none"
              r="8"
              stroke="currentColor"
              strokeDasharray="2 2"
              strokeWidth="1"
            />
          )}
          <text fill="currentColor" fontSize="11" textAnchor="middle" x={12 + index * 25} y="32">
            {nasal.includes(index + 1) ? withoutDakuten(mora) : mora}
          </text>
          {nasal.includes(index + 1) && (
            <circle
              className="dictionary-pitch__nasal"
              cx={12 + index * 25 + 7}
              cy="22"
              fill="none"
              r="2"
              stroke="currentColor"
              strokeWidth="1"
            />
          )}
        </g>
      ))}
    </svg>
  );
}
