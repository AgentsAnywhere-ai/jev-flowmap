// Internal store. Nothing here decides anything.
const rows = new Map();
export const put = (id, value) => rows.set(id, value);
export const get = (id) => rows.get(id);
