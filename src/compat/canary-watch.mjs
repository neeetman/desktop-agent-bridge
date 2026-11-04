// Only unsupported bytes trigger background work. Busy, revoked, absent or
// ambiguous processes are never interpreted as a new desktop version.
export function unknownPair(apps) {
  const names = ["codex", "claude"];
  if (
    names.some(
      (name) =>
        !apps[name]?.runningBuild?.hashes ||
        (apps[name].code && apps[name].code !== "BUILD_UNSUPPORTED"),
    )
  )
    return null;
  const unknown = names.filter(
    (name) => apps[name].code === "BUILD_UNSUPPORTED",
  );
  if (!unknown.length) return null;
  const key = names
    .map((name) =>
      Object.entries(apps[name].runningBuild.hashes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => k + "=" + v)
        .join(","),
    )
    .join("|");
  return { key, unknown };
}
