/** Distances on the map. */

export const METRES_PER_DEGREE = 111_320;

/** Straight-line distance in metres (equirectangular: plenty accurate for a few hundred metres). */
export function distanceMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y) * METRES_PER_DEGREE;
}
