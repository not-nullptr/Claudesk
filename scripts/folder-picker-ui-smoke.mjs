import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ""; this.dataset = {}; this.hidden = false; }
  setAttribute(name, value) { this[name] = value; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatch(name, event = {}) { for (const callback of this.listeners[name] || []) callback({ preventDefault() {}, ...event }); }
  getBoundingClientRect() { return { left: 100, top: 100, right: 660, bottom: 600 }; }
  click() { assert.ok(!this.disabled); this.dispatch("click"); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
}
const body = new Element("body");
const requests = [], created = [], posts = [];
let missing = false, createFails = null, codeColdReads = 0;
function listingFor(path) {
  return { root: "/workspace", path,
    parent: path === "/workspace" ? null : "/workspace",
    folders: path === "/workspace"
      ? [{ name: "a", path: "/workspace/a" }, { name: "b", path: "/workspace/b" }] : [],
    truncated: false };
}
const context = { document: { body, activeElement: new Element("button"),
  createElement(tag) { const element = new Element(tag); created.push(element); return element; } },
  AbortController, setTimeout, clearTimeout, fetch: async (url, options = {}) => {
    assert.ok(options.signal);
    const parsed = new URL(url, "https://claudesk.invalid");
    if (options.method === "POST" && parsed.pathname === "/api/remote/folders") {
      const body = JSON.parse(options.body);
      posts.push(body);
      if (createFails) return { ok: false, json: async () => ({ ok: false, error: createFails }) };
      return { ok: true, json: async () => ({ ok: true, value: { path: `${body.path}/${body.name}`, name: body.name } }) };
    }
    const path = parsed.searchParams.get("path") || "/workspace";
    requests.push(path);
    if (parsed.pathname === "/api/remote/code-folders" && codeColdReads > 0) {
      codeColdReads -= 1;
      return { ok: false, status: 503,
        json: async () => ({ ok: false, error: "no guest runner is online" }) };
    }
    if (path === "/outside" || (missing && path === "/workspace/a")) {
      return { ok: false, json: async () => ({ ok: false, error: "Folder unavailable" }) };
    }
    return { ok: true, json: async () => ({ ok: true, value: listingFor(path) }) };
  } };
vm.runInNewContext(await readFile(new URL("../bridge/public/remote-folder-picker.js", import.meta.url), "utf8"), context);
const pick = context.__CLAUDE_PICK_SERVER_FOLDERS__;
function all(node = body) { return [node, ...node.children.flatMap(child => all(child))]; }
function button(label) { return all().find(node => node.tag === "button" && node.textContent === label); }
function nameInput() { return all().find(node => node["aria-label"] === "New folder name"); }
const settle = () => new Promise(resolve => setImmediate(resolve));

let result = pick({ title: "Choose project folder" });
await settle();
button("a").click();
await settle();
assert.ok(all().some(node => node.textContent === "/workspace/a"));
button("Choose this folder").click();
assert.deepEqual(Array.from(await result), ["/workspace/a"]);
assert.equal(body.children.length, 0);

result = pick({ multiple: true });
await settle();
for (const name of ["a", "b"]) {
  const input = all().find(node => node["aria-label"] === `Select ${name}`);
  input.checked = true;
  input.dispatch("change");
}
button("Choose folders (2)").click();
assert.deepEqual(Array.from(await result), ["/workspace/a", "/workspace/b"]);

// A caller may hand a start folder outside the browsable workspace (Desktop's
// own default is the home directory); the picker falls back to the root rather
// than stranding the reader on an error.
result = pick({ initialPath: "/outside" });
await settle();
assert.ok(all().some(node => node.textContent === "/workspace"), "an off-workspace start folder falls back to the root");
button("Workspace").click();
await settle();
body.children[0].dispatch("cancel");
assert.equal(await result, null);

result = pick();
await settle();
const search = all().find(node => node.type === "search");
search.value = "b";
search.dispatch("input");
assert.equal(button("a").parent.hidden, true);
assert.equal(button("b").parent.hidden, false);
const dialog = body.children[0];
const outside = { target: dialog, clientX: 10, clientY: 10 };
dialog.dispatch("pointerdown", { target: button("b"), clientX: 200, clientY: 200 });
dialog.dispatch("click", outside);
assert.equal(body.children.length, 1, "dragging from inside must not dismiss");
dialog.dispatch("pointerdown", outside);
dialog.dispatch("click", outside);
assert.equal(await result, null, "clicking the backdrop dismisses the picker");

result = pick();
await settle();
all().find(node => node["aria-label"] === "Close folder picker").click();
assert.equal(await result, null);

// "New folder": creating a directory is part of the native dialog the picker
// replaces, so it is offered here, posts to the confinement-checked bridge
// route, and navigates into the folder it created.
result = pick({ title: "Select Directory to Share", allowCreate: true });
await settle();
assert.equal(button("Create folder").parent.hidden, true, "the create row starts hidden");
button("New folder").click();
assert.equal(button("Create folder").parent.hidden, false);
nameInput().value = "shared";
button("Create folder").click();
await settle();
assert.deepEqual(posts.at(-1), { path: "/workspace", name: "shared" });
assert.ok(all().some(node => node.textContent === "/workspace/shared"), "the picker opens the created folder");
assert.ok(all().some(node => node.textContent === "Created /workspace/shared."));
button("Choose this folder").click();
assert.deepEqual(Array.from(await result), ["/workspace/shared"]);

// A refused create reports the bridge's message and keeps the dialog open.
createFails = "a folder with that name already exists";
result = pick({ allowCreate: true });
await settle();
button("New folder").click();
nameInput().value = "a";
button("Create folder").click();
await settle();
assert.ok(all().some(node => node.textContent === "a folder with that name already exists"));
button("Cancel").click();
assert.equal(await result, null);
createFails = null;

// A dialog that forbids creating does not offer the affordance.
result = pick({ allowCreate: false });
await settle();
assert.equal(all().some(node => node.tag === "button" && node.textContent === "New folder"), false,
  "creation is hidden when the dialog does not allow it");
body.children[0].dispatch("cancel");
assert.equal(await result, null);

result = pick({ multiple: true });
await settle();
const input = all().find(node => node["aria-label"] === "Select a");
input.checked = true;
input.dispatch("change");
missing = true;
button("Choose folders (1)").click();
await settle();
assert.equal(body.children.length, 1, "failed revalidation must not return a stale selection");
assert.ok(all().some(node => node.textContent === "Folder unavailable"));
button("Cancel").click();
assert.equal(await result, null);

// The Code picker's listing is guest-only. A cold VM answers 503; the picker
// says it is starting the workspace and asks the guest route again, rather
// than falling back to the bridge's own mount. The retry is on a 1.5 s timer.
missing = false;
codeColdReads = 1;
result = pick({ source: "code" });
await new Promise(resolve => setTimeout(resolve, 2500));
assert.equal(codeColdReads, 0, "the cold answer was retried");
assert.ok(all().some(node => node.textContent === "a"),
  "the retried Code listing renders the guest's folders");
button("Choose this folder").click();
assert.deepEqual(Array.from(await result), ["/workspace"]);
assert.ok(!created.some(node => node.type === "file"), "never create a native file picker");
assert.ok(requests.includes("/workspace/a"));
console.log("folder-picker-ui-smoke: navigation, multi-select, new folder, Escape, errors and server revalidation passed");
