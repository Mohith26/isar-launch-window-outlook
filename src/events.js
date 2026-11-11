// Dated events from Isar Aerospace's public campaign record, used to check the default launch
// criteria. weather: 'go' = the team proceeded to an attempt (fuelling/countdown) or launched;
// 'no-go' = moved or called off for weather; 'unknown' = no public weather statement.
// Windows: Flight 2 attempts were announced for ~20:00 UTC (21 Jan "21:00 CET", 15 Jun 20:00 UTC,
// liftoff 5 Sep 22:12 CEST = 20:12 UTC); a 90-minute window like Flight 3's NOTAM is assumed.
// Flight 1 lifted off 30 Mar 2025 at 12:30 CEST (10:30 UTC); a 10:00-13:00 UTC window is assumed.
export const EVENTS = [
  { windowOpen: '2025-03-30T10:00Z', durMin: 180, weather: 'go', what: 'Flight 1 lifts off (12:30 CEST)', source: 'isaraerospace.com press release, 30 Mar 2025' },
  { windowOpen: '2026-01-21T20:00Z', durMin: 90, weather: 'go', what: 'Flight 2 attempt, scrubbed for a pressurisation valve', source: 'Isar mission updates log' },
  { windowOpen: '2026-03-19T20:00Z', durMin: 90, weather: 'no-go', what: 'NET 19 Mar moved to 23 Mar, unfavourable weather', source: 'Isar mission updates log (18 Mar)' },
  { windowOpen: '2026-03-23T20:00Z', durMin: 90, weather: 'no-go', what: 'Moved to 25 Mar, strong winds', source: 'Isar mission updates log (23 Mar)' },
  { windowOpen: '2026-03-25T20:00Z', durMin: 90, weather: 'go', what: 'Propellant loading, aborted after a range violation', source: 'Isar mission updates log (25-26 Mar)' },
  { windowOpen: '2026-06-15T20:00Z', durMin: 90, weather: 'go', what: 'Attempt, scrubbed for fluid-system behaviour', source: 'Isar mission updates log (15 Jun)' },
  { windowOpen: '2026-09-04T20:00Z', durMin: 90, weather: 'unknown', what: 'Called off after road closures; ~24 kt reported at Andøya airport', source: 'European Spaceflight, 4 Sep 2026 (no official reason)' },
  { windowOpen: '2026-09-05T20:00Z', durMin: 90, weather: 'go', what: 'Flight 2 lifts off (22:12 CEST), reaches orbit', source: 'isaraerospace.com press release, 5 Sep 2026' },
];
