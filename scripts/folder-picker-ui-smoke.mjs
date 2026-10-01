import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ""; this.dataset = {}; }
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
const requests = [], created = [];
let missing = false;
const context = { document: { body, activeElement: new Element("button"),
  createElement(tag) { const element = new Element(tag); created.push(element); return element; } },
  AbortController, fetch: async (url, options) => {
    assert.ok(options.signal);
    const path = new URL(url, "https://nas.invalid").searchParams.get("path") || "/workspace";
    requests.push(path);
    if (path === "/outside" || (missing && path === "/workspace/a")) {
      return { ok: false, json: async () => ({ ok: false, error: "Folder unavailable" }) };
    }
    return { ok: true, json: async () => ({ ok: true, value: { root: "/workspace", path,
      parent: path === "/workspace" ? null : "/workspace", folders: path === "/workspace"
        ? [{ name: "a", path: "/workspace/a" }, { name: "b", path: "/workspace/b" }] : [], truncated: false } }) };
  } };
vm.runInNewContext(await readFile(new URL("../bridge/public/remote-folder-picker.js", import.meta.url), "utf8"), context);
const pick = context.__CLAUDE_PICK_SERVER_FOLDERS__;
function all(node = body) { return [node, ...node.children.flatMap(child => all(child))]; }
function button(label) { return all().find(node => node.tag === "button" && node.textContent === label); }
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

result = pick({ initialPath: "/outside" });
await settle();
assert.ok(all().some(node => node.textContent === "Folder unavailable"));
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
assert.ok(!created.some(node => node.type === "file"), "never create a native file picker");
assert.ok(requests.includes("/workspace/a"));
console.log("folder-picker-ui-smoke: navigation, multi-select, Escape, errors and server revalidation passed");
