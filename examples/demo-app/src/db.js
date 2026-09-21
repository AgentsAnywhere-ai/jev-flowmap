// Internal store. No caller outside this project reaches it.
const rows = new Map();
export const put = (id, value) => rows.set(id, value);
export const get = (id) => rows.get(id);
export const drop = (id) => rows.delete(id);
