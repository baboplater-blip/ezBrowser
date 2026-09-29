"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAction = registerAction;
exports.getAction = getAction;
exports.listActions = listActions;
exports.runAction = runAction;
exports.listByContext = listByContext;
const actions = new Map();
function registerAction(action) {
    if (actions.has(action.id)) {
        console.warn(`[actions] duplicate id ${action.id} — overwriting`);
    }
    actions.set(action.id, action);
}
function getAction(id) {
    return actions.get(id);
}
function listActions() {
    return Array.from(actions.values()).map((a) => ({
        id: a.id,
        category: a.category,
        labelKey: a.labelKey,
        defaultKey: a.defaultKey,
        when: a.when,
    }));
}
async function runAction(id, ctx) {
    const a = actions.get(id);
    if (!a) {
        console.warn(`[actions] unknown action ${id}`);
        return false;
    }
    if (a.enabled && !a.enabled(ctx))
        return false;
    try {
        await a.run(ctx);
        return true;
    }
    catch (err) {
        console.error(`[actions] ${id} failed`, err);
        return false;
    }
}
function listByContext(when) {
    return listActions().filter((a) => !a.when || a.when === when || a.when === 'global');
}
