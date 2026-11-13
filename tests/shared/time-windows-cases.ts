/** Shared cases for the app (Zod) and database (CHECK) validators of booking time windows. */
export const validTimeWindows: Array<[string, unknown]> = [
  ["empty list", []],
  [
    "morning and afternoon",
    [
      { start: "08:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ],
  ],
  [
    "touching windows",
    [
      { start: "09:00", end: "12:00" },
      { start: "12:00", end: "15:00" },
    ],
  ],
  ["whole day ending at 24:00", [{ start: "00:00", end: "24:00" }]],
  ["late window ending at 24:00", [{ start: "22:00", end: "24:00" }]],
  [
    "twelve windows",
    Array.from({ length: 12 }, (_, i) => ({
      start: `${String(i + 8).padStart(2, "0")}:00`,
      end: `${String(i + 8).padStart(2, "0")}:30`,
    })),
  ],
];

export const invalidTimeWindows: Array<[string, unknown]> = [
  ["not an array", { start: "08:00", end: "12:00" }],
  ["null element", [null]],
  ["string element", ["08:00-12:00"]],
  ["missing end", [{ start: "08:00" }]],
  ["extra key", [{ start: "08:00", end: "12:00", label: "morning" }]],
  ["numeric values", [{ start: 800, end: 1200 }]],
  ["single-digit hour", [{ start: "8:00", end: "12:00" }]],
  ["start at 24:00", [{ start: "24:00", end: "24:00" }]],
  ["end after 24:00", [{ start: "22:00", end: "24:30" }]],
  ["hour 25", [{ start: "25:00", end: "26:00" }]],
  ["start equals end", [{ start: "10:00", end: "10:00" }]],
  ["start after end (crosses midnight)", [{ start: "22:00", end: "02:00" }]],
  [
    "overlapping",
    [
      { start: "08:00", end: "12:00" },
      { start: "11:00", end: "14:00" },
    ],
  ],
  [
    "unsorted",
    [
      { start: "13:00", end: "17:00" },
      { start: "08:00", end: "12:00" },
    ],
  ],
  [
    "thirteen windows",
    Array.from({ length: 13 }, (_, i) => ({
      start: `${String(i + 8).padStart(2, "0")}:00`,
      end: `${String(i + 8).padStart(2, "0")}:30`,
    })),
  ],
];
