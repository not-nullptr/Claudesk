import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Reading a file that is not in one of the session's own folders makes the
// Desktop main process open a native "File Access Request" card before it reads
// anything. This container's display is headless, so nothing can answer the
// card, and the read — and with it the browser's IPC request — hangs forever.
// The file pane previewing an agent memory file is the case that shows up, and
// the memory editor opening CLAUDE.md is the same card. These checks pin the
// wrapper's answer to that card, its two button orders, the pass-through of
// every other dialog, and the shapes it refuses to answer blind.

const wrapper = await readFile(new URL("../bridge-wrapper/main.cjs", import.meta.url), "utf8");
const start = wrapper.indexOf("const fileAccessCardMessage =");
const end = wrapper.indexOf("const server = http.createServer(", start);
assert.ok(start > 0 && end > start, "the wrapper still carries the file access consent section");
const consentSource = wrapper.slice(start, end);
assert.ok(consentSource.includes("if (fileAccessConsentEnabled)"),
  "the section must stay behind its own flag");

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadSandbox({ enabled = true } = {}) {
  const logged = [];
  const dialogs = [];
  const fakeDialog = {
    async showMessageBox(...args) {
      dialogs.push(args);
      return { response: 7, checkboxChecked: true };
    },
  };
  const sandbox = {
    require: (name) => { assert.equal(name, "electron"); return { dialog: fakeDialog }; },
    fileAccessConsentEnabled: enabled,
    console: { ...console, info: (line) => logged.push(line), log: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(consentSource, sandbox);
  return { sandbox, fakeDialog, logged, dialogs };
}

// The card as the file reader builds it for a memory-file preview:
// `n.n(false)` is ["Cancel","Allow"] with both indices 0, and `detail` carries
// the path it is about.
const memoryPath = "/config/.config/Claude-3p/local-agent-mode-sessions/819dba58"
  + "/00000000/memory/memory/feedback_brevity.md";
const previewCard = {
  type: "question",
  buttons: ["Cancel", "Allow"],
  defaultId: 0,
  cancelId: 0,
  title: "File Access Request",
  message: "Allow Claude to preview this file?",
  detail: `${memoryPath}\n\nThis will allow Claude to preview the file.`,
};

// --- preview: answered Allow, in both call forms, and logged -----------------
{
  const { sandbox, fakeDialog, logged } = loadSandbox();
  const windowForm = await fakeDialog.showMessageBox({ isDestroyed: () => false }, previewCard);
  assert.deepEqual(plain(windowForm), { response: 1, checkboxChecked: false },
    "the preview card must be answered with Allow (index 1) rather than opened");
  const optionsForm = await fakeDialog.showMessageBox(previewCard);
  assert.deepEqual(plain(optionsForm), { response: 1, checkboxChecked: false },
    "the options-first call form must be answered the same way");
  assert.equal(logged.length, 2, "each answer must be logged");
  assert.ok(logged[0].includes("preview"), `the log must name the action: ${logged[0]}`);
  assert.ok(logged[0].includes(memoryPath), `the log must name the path: ${logged[0]}`);
  // The counter is a `const` in the section, so it lives in the context's
  // lexical scope rather than on the sandbox object; read it from there.
  assert.equal(vm.runInContext("fileAccessConsentState.answered", sandbox), 2,
    "the answers are counted for /runtime to report");
}

// --- the buttons the other way round: the allow index is the other one -------
{
  const { fakeDialog } = loadSandbox();
  const flipped = await fakeDialog.showMessageBox({
    ...previewCard,
    buttons: ["Allow", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  assert.deepEqual(plain(flipped), { response: 0, checkboxChecked: false },
    "an allow button at index 0 must be answered with index 0");
}

// --- open: the same card, a different question, the same single answer -------
{
  const { fakeDialog, logged } = loadSandbox();
  const opened = await fakeDialog.showMessageBox({
    ...previewCard,
    message: "Allow Claude to open this file?",
    detail: "/workspace/report.docx\n\nThis will allow Claude to open the file with your default application.",
  });
  assert.deepEqual(plain(opened), { response: 1, checkboxChecked: false });
  assert.ok(logged[0].includes("open"), `the log must name the open action: ${logged[0]}`);
}

// --- everything else still opens for real ------------------------------------
{
  const { fakeDialog, dialogs } = loadSandbox();
  const unrelated = await fakeDialog.showMessageBox({}, {
    type: "question",
    buttons: ["Cancel", "Delete"],
    defaultId: 0,
    cancelId: 0,
    title: "Delete this task?",
    message: "This cannot be undone.",
  });
  assert.equal(dialogs.length, 1, "an unrelated message box must reach the native dialog");
  assert.deepEqual(plain(unrelated), { response: 7, checkboxChecked: true });

  const shapeless = await fakeDialog.showMessageBox({}, {
    ...previewCard,
    cancelId: undefined,
    defaultId: undefined,
  });
  assert.equal(dialogs.length, 2, "a card with no cancel index must not be answered blind");

  const extraButton = await fakeDialog.showMessageBox({}, {
    ...previewCard,
    buttons: ["Cancel", "Allow", "Always allow"],
  });
  assert.equal(dialogs.length, 3, "a card with an unexpected button count must not be answered blind");
  assert.deepEqual(plain(extraButton), { response: 7, checkboxChecked: true });
}

// --- the flag turns it off, and then the native dialog is back ---------------
{
  const { fakeDialog, dialogs } = loadSandbox({ enabled: false });
  const result = await fakeDialog.showMessageBox(previewCard);
  assert.equal(dialogs.length, 1, "with CLAUDE_REMOTE_FILE_CONSENT=0 the card opens for real");
  assert.deepEqual(plain(result), { response: 7, checkboxChecked: true });
}

console.log("file-consent-smoke: the File Access Request card is answered without opening a dialog");
