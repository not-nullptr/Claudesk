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
      dialog.setAttribute("aria-describedby", "remote-folder-picker-hint");
      const header = document.createElement("div");
      header.className = "remote-folder-picker-header";
      const introduction = document.createElement("div");
      const heading = document.createElement("h2");
      heading.id = "remote-folder-picker-title";
      heading.textContent = title || "Choose a server folder";
      const hint = document.createElement("p");
      hint.id = "remote-folder-picker-hint";
      hint.textContent = multiple ? "Select folders from your workspace." : "Choose a folder from your workspace.";
      introduction.append(heading, hint);
      header.append(introduction);
      const navigation = document.createElement("div");
      navigation.className = "remote-folder-picker-navigation";
      const pathLabel = document.createElement("p");
      pathLabel.className = "remote-folder-picker-path";
      const status = document.createElement("p");
      status.className = "remote-folder-picker-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const entries = document.createElement("div");
      entries.className = "remote-folder-picker-entries";
      const search = document.createElement("input");
      search.type = "search";
      search.className = "remote-folder-picker-search";
      search.placeholder = "Find a folder…";
      search.setAttribute("aria-label", "Filter folders in this directory");
      search.addEventListener("input", () => {
        const query = search.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const row of entries.children) {
          row.hidden = !!row.dataset.name && !row.dataset.name.includes(query);
          if (row.dataset.name && !row.hidden) visible++;
        }
        status.textContent = current?.folders.length && !visible ? "No matching folders." : "";
      });
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
      up.setAttribute("aria-label", "Go to parent folder");
      up.className = "remote-folder-picker-up";
      const close = button("×", () => finish(null), header);
      close.className = "remote-folder-picker-close";
      close.setAttribute("aria-label", "Close folder picker");
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
      choose.className = "remote-folder-picker-primary";
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
          pathLabel.title = value.path;
          search.value = "";
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
            row.dataset.name = folder.name.toLocaleLowerCase();
            if (multiple) checkbox(folder.path, `Select ${folder.name}`, row);
            const open = button(folder.name, () => load(folder.path), row);
            open.className = "remote-folder-picker-folder";
            open.title = `Open ${folder.name}`;
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
      navigation.append(pathLabel);
      dialog.append(header, navigation, search, entries, status, footer);
      // Native dialog backdrop events target the dialog itself. Require both
      // pointer-down and click outside so dragging from inside never dismisses.
      let pressedOutside = false;
      function outside(event) {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom);
      }
      dialog.addEventListener("pointerdown", event => { pressedOutside = outside(event); });
      dialog.addEventListener("click", event => {
        if (pressedOutside && outside(event)) finish(null);
        pressedOutside = false;
      });
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
