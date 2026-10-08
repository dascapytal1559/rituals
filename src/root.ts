// The repository (or live folder) root: the parent of src/. Data, queue, config and views live under it.
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
