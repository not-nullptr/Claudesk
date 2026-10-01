(() => {
  "use strict";
  let active;
  async function listing(path, signal) {
    const response = await fetch(`/api/remote/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`, { signal });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Could not browse server folders");
    return result.value;
  }
  globalThis.__CLAUDE_PICK_SERVER_FOLDERS__ = function ({ title, multiple = false, initialPath } = {}) {
    if (active) return active;
    active = new Promise(resolve => {
      const previousFocus = document.activeElement;
      const controller = new AbortController();
      const selected = new Set();
      const dialog = document.createElement("dialog");
      dialog.className = "remote-folder-picker";
      dialog.setAttribute("aria-labelledby", "remote-folder-picker-title");
      const heading = document.createElement("h2");
      heading.id = "remote-folder-picker-title";
      heading.textContent = title || "Choose a server folder";
      const hint = document.createElement("p");
      hint.textContent = "Folders on the server workspace";
      const navigation = document.createElement("div");
      navigation.className = "remote-folder-picker-navigation";
      const pathLabel = document.createElement("p");
      pathLabel.className = "remote-folder-picker-path";
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const entries = document.createElement("div");
      entries.className = "remote-folder-picker-entries";
      const footer = document.createElement("div");
      footer.className = "remote-folder-picker-footer";
      let current, generation = 0, finished = false, busy = false;
      function button(label, action, parent) {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = label;
        node.addEventListener("click", action);
        parent.append(node);
        return node;
      }
      function finish(value) {
        if (finished) return;
        finished = true;
        controller.abort();
        dialog.close();
        dialog.remove();
        previousFocus?.focus?.();
        resolve(value);
      }
      const root = button("Workspace", () => load(), navigation);
      const up = button("Up", () => current?.parent && load(current.parent), navigation);
      const cancel = button("Cancel", () => finish(null), footer);
      const choose = button("Choose folder", async () => {
        if (busy || !current) return;
        const paths = multiple ? [...selected] : [current.path];
        if (!paths.length) return;
        busy = true;
        choose.disabled = true;
        try {
          // Revalidate selections on the server immediately before returning
          // paths to Desktop (folders can disappear while the dialog is open).
          const confirmed = [];
          for (const path of paths) confirmed.push((await listing(path, controller.signal)).path);
          finish([...new Set(confirmed)]);
        } catch (error) {
          if (!finished) status.textContent = error.message;
        } finally {
          busy = false;
          updateSelection();
        }
      }, footer);
      function updateSelection() {
        choose.textContent = multiple ? `Choose folders (${selected.size})` : "Choose this folder";
        choose.disabled = busy || !current || (multiple && selected.size === 0);
      }
      function checkbox(path, label, parent) {
        const wrapper = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selected.has(path);
        input.setAttribute("aria-label", label);
        input.addEventListener("change", () => {
          if (input.checked) selected.add(path); else selected.delete(path);
          updateSelection();
        });
        wrapper.append(input);
        parent.append(wrapper);
      }
      async function load(path) {
        const request = ++generation;
        busy = true;
        updateSelection();
        status.textContent = "Loading server folders…";
        try {
          const value = await listing(path, controller.signal);
          if (finished || request !== generation) return;
          current = value;
          pathLabel.textContent = value.path;
          up.disabled = !value.parent;
          entries.replaceChildren();
          if (multiple) {
            const row = document.createElement("div");
            row.className = "remote-folder-picker-row";
            checkbox(value.path, "Include this folder", row);
            const label = document.createElement("span");
            label.textContent = "Include this folder";
            row.append(label);
            entries.append(row);
          }
          for (const folder of value.folders) {
            const row = document.createElement("div");
            row.className = "remote-folder-picker-row";
            if (multiple) checkbox(folder.path, `Select ${folder.name}`, row);
            button(folder.name, () => load(folder.path), row);
            entries.append(row);
          }
          status.textContent = value.truncated ? "Showing the first 1,000 folders." : value.folders.length ? "" : "This folder has no subfolders.";
        } catch (error) {
          if (!finished && request === generation) status.textContent = error.message;
        } finally {
          if (!finished && request === generation) {
            busy = false;
            updateSelection();
          }
        }
      }
      dialog.append(heading, hint, navigation, pathLabel, entries, status, footer);
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
      dialog.addEventListener("close", () => finish(null));
      document.body.append(dialog);
      dialog.showModal();
      cancel.focus();
      load(initialPath);
    }).finally(() => { active = undefined; });
    return active;
  };
})();
