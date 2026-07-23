// index.js - static map registry; ?map= selects, default = town (brief section 2.1)
import plaza from "./plaza.js";
import town from "./town.js";
import yard from "./yard.js";
import canyon from "./canyon.js";

export const MAPS = { plaza, town, yard, canyon };
export const DEFAULT_MAP_ID = "town";
export const MAP_IDS = ["town", "yard", "canyon", "plaza"];

export function getMap(id) {
  return MAPS[id] || MAPS[DEFAULT_MAP_ID];
}
