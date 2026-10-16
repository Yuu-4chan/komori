// Native code names a cover thumbnail by catalog ID and cover revision on Komori's own cover
// protocol, in either platform form; nothing else reaches an <img>.
const coverUrlPattern =
  /^(?:http:\/\/komori-cover\.localhost|komori-cover:\/\/localhost)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\d{1,15}$/;

export function safeCoverUrl(value: string | null | undefined): string | null {
  return typeof value === "string" && coverUrlPattern.test(value) ? value : null;
}
