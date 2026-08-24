
const fs = require("node:fs");
const vm = require("node:vm");
const React = require("react");
const code = fs.readFileSync(require("node:path").join(__dirname, "..", "client", "dist", "client.js"), "utf8");

let loaded = null;
const sandboxWindow = { __ModuleLoader__: { load: (rec) => { loaded = rec; } } };
const sandbox = {
  window: sandboxWindow,
  require: (spec) => {
    if (spec === "react") return React;
    throw new Error("unexpected require: " + spec);
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "client.js" });
console.log("load() called:", loaded !== null, "| id:", loaded && loaded.id);

const mod = loaded.factory(sandbox.require);
console.log("exports keys:", Object.keys(exports).join(","));

const registrations = [];
const injectionEffects = [];
const ctx = {
  slots: {
    register: (spec, component) => registrations.push({ spec, component }),
    inject: (key, cb) => injectionEffects.push({ key, cb }),
  },
};
mod.apply(ctx);
console.log("inject targets:", injectionEffects.map((e) => e.key).join(","));
for (const e of injectionEffects) e.cb();
console.log("registrations:", registrations.map((r) => r.spec.name + "#" + r.spec.id).join(","));
const comp = registrations[0].component;
console.log("component is function:", typeof comp === "function");