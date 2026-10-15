// Applies the remote shim to the official ion-dist entry document and refuses a
// page that did not take it.
//
// The insertions use a FUNCTION replacer, never a string one. The replacement
// text is data: `injection` carries the bootstrap JSON, which embeds the
// prepared renderer manifest, and a patch's `original`/`replacement` are verbatim
// renderer source. When that source contains a `$` replacement pattern — the new
// native-file-preview patch splices a children array holding `$&&s("img",…)`, so
// it carries `$&` — `String.prototype.replace` expands `$&`, `$'`, `` $` `` and
// `$1` inside a *string* replacement. That rewrote the JSON into the matched
// `<script type="module"`, turning the inline bootstrap into a SyntaxError; the
// browser then had no `__CLAUDE_REMOTE_BOOTSTRAP__`, the preload bailed out, and
// ion-dist silently dropped Chat and fell through to the Claude Code landing.
export function shimOfficialIndex(html, { injection, overrideStyles, rendererBase, bootstrapJson,
  webShell = false }) {
  const shimmed = html
    .replace('<link rel="manifest" href="/manifest.json">', "")
    .replace('<script type="module"', () => `${injection}<script type="module"`)
    .replace(
      /\b(href|src)="\/(assets|images|audio|i18n|_frame-rt)\//g,
      `$1="${rendererBase}/$2/`,
    )
    .replace("</head>", () => `${overrideStyles}</head>`);
  // claude.ai's server fills in two attributes on its own entry document — the
  // composer arm on the static skeleton and the page-layout variant on <html> —
  // and the Desktop package ships that document with neither. They are what the
  // *first* paint reads: the skeleton's own CSS keys the smaller home greeting
  // off `html[data-new-page-layout=home]`, and every `data-composer-arm=marlin`
  // rule in the shell keys the marlin card off the attribute. Without them the
  // skeleton is always the classic one, whatever the renderer decides afterwards.
  // The web shell's deployment has already made both choices (the bridge grants
  // the composer feature and the renderer patch turns the layout on), so the
  // attributes are filled in here. Fixed markup or nothing: an entry that no
  // longer carries it is served as it is, since this only changes which of the
  // two designs paints first.
  const annotated = !webShell ? shimmed : shimmed
    .replace("<html ", () => '<html data-new-page-layout="home" ')
    .replace('<div id="static-composer"', () => '<div id="static-composer" data-composer-arm="marlin"');
  // Byte-check the injected config. A corrupted or reformatted injection must be
  // refused rather than served: if the inline script does not evaluate, the
  // browser has no desktopBootFeatures and ion-dist removes the Chat surface.
  // This catches both a `$`-expanded injection and an entry that no longer
  // carries the module script the bootstrap is spliced before.
  if (!annotated.includes(bootstrapJson)) {
    throw new Error("official ion-dist entry format changed; refusing an unshimmed page");
  }
  if (!annotated.includes(`${rendererBase}/assets/`)) {
    throw new Error("official ion-dist entry changed; refusing a mixed renderer module graph");
  }
  return annotated;
}
