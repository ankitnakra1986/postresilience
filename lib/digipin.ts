/**
 * DIGIPIN encoder / decoder.
 *
 * Algorithm ported verbatim from the official India Post implementation:
 *   https://github.com/INDIAPOST-gov/digipin/blob/main/src/digipin.js
 * Released under an open-source license by India Post / Department of Posts,
 * IIT Hyderabad, and NRSC (ISRO).
 *
 * A DIGIPIN is a 10-character alphanumeric grid code formatted as `XXX-XXX-XXXX`,
 * derived by recursively subdividing a bounding box covering India + buffer.
 */

const DIGIPIN_GRID: ReadonlyArray<ReadonlyArray<string>> = [
  ["F", "C", "9", "8"],
  ["J", "3", "2", "7"],
  ["K", "4", "5", "6"],
  ["L", "M", "P", "T"],
];

const BOUNDS = {
  minLat: 2.5,
  maxLat: 38.5,
  minLon: 63.5,
  maxLon: 99.5,
} as const;

const VALID_CHARS = new Set(DIGIPIN_GRID.flat());

export function encodeDigiPin(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Latitude and longitude must be finite numbers");
  }
  if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat) {
    throw new Error(`Latitude ${lat} out of DIGIPIN range (${BOUNDS.minLat}–${BOUNDS.maxLat})`);
  }
  if (lon < BOUNDS.minLon || lon > BOUNDS.maxLon) {
    throw new Error(`Longitude ${lon} out of DIGIPIN range (${BOUNDS.minLon}–${BOUNDS.maxLon})`);
  }

  let minLat: number = BOUNDS.minLat;
  let maxLat: number = BOUNDS.maxLat;
  let minLon: number = BOUNDS.minLon;
  let maxLon: number = BOUNDS.maxLon;

  let digiPin = "";

  for (let level = 1; level <= 10; level++) {
    const latDiv = (maxLat - minLat) / 4;
    const lonDiv = (maxLon - minLon) / 4;

    let row = 3 - Math.floor((lat - minLat) / latDiv);
    let col = Math.floor((lon - minLon) / lonDiv);

    row = Math.max(0, Math.min(row, 3));
    col = Math.max(0, Math.min(col, 3));

    digiPin += DIGIPIN_GRID[row][col];

    if (level === 3 || level === 6) digiPin += "-";

    const newMaxLat = minLat + latDiv * (4 - row);
    const newMinLat = minLat + latDiv * (3 - row);
    minLat = newMinLat;
    maxLat = newMaxLat;

    minLon = minLon + lonDiv * col;
    maxLon = minLon + lonDiv;
  }

  return digiPin;
}

export type DecodedDigiPin = { latitude: number; longitude: number };

export function decodeDigiPin(digiPin: string): DecodedDigiPin {
  const pin = digiPin.replace(/-/g, "").toUpperCase();
  if (pin.length !== 10) {
    throw new Error("DIGIPIN must be 10 characters (excluding dashes)");
  }

  let minLat: number = BOUNDS.minLat;
  let maxLat: number = BOUNDS.maxLat;
  let minLon: number = BOUNDS.minLon;
  let maxLon: number = BOUNDS.maxLon;

  for (let i = 0; i < 10; i++) {
    const ch = pin[i];
    let ri = -1;
    let ci = -1;
    for (let r = 0; r < 4 && ri === -1; r++) {
      for (let c = 0; c < 4; c++) {
        if (DIGIPIN_GRID[r][c] === ch) {
          ri = r;
          ci = c;
          break;
        }
      }
    }
    if (ri === -1) {
      throw new Error(`Invalid character "${ch}" in DIGIPIN`);
    }

    const latDiv = (maxLat - minLat) / 4;
    const lonDiv = (maxLon - minLon) / 4;

    const lat1 = maxLat - latDiv * (ri + 1);
    const lat2 = maxLat - latDiv * ri;
    const lon1 = minLon + lonDiv * ci;
    const lon2 = minLon + lonDiv * (ci + 1);

    minLat = lat1;
    maxLat = lat2;
    minLon = lon1;
    maxLon = lon2;
  }

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
  };
}

export function isValidDigiPin(value: string): boolean {
  const pin = value.replace(/-/g, "").toUpperCase();
  if (pin.length !== 10) return false;
  for (const ch of pin) {
    if (!VALID_CHARS.has(ch)) return false;
  }
  return true;
}

export function formatDigiPin(value: string): string {
  const pin = value.replace(/-/g, "").toUpperCase();
  if (pin.length <= 3) return pin;
  if (pin.length <= 6) return `${pin.slice(0, 3)}-${pin.slice(3)}`;
  return `${pin.slice(0, 3)}-${pin.slice(3, 6)}-${pin.slice(6, 10)}`;
}

/**
 * Demo-only district inference for the Kerala flood scenario.
 * Splits Thrissur (north) from Ernakulam (south) at ~10.2°N.
 * Anything outside the demo bbox falls back to "Other".
 */
export function inferKeralaDistrict(lat: number, lon: number): string {
  if (lat < 9.5 || lat > 11.0 || lon < 75.5 || lon > 77.0) return "Other";
  return lat > 10.2 ? "Thrissur" : "Ernakulam";
}
