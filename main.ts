import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Game = {
  rank: number;
  universe_id: number;
  playing: number;
};

type Snapshot = {
  top_trending?: Array<{ rank?: number; universe_id?: number; playing?: number }>;
};

type Task = {
  places?: number;
  output?: string;
};

type RankedGame = Game & {
  momentum: number;
  confidence: number;
  score: number;
  projectedRank: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

function readTask(): Task {
  try {
    const value: unknown = JSON.parse(readFileSync(join(inputDir, "task.json"), "utf8"));
    if (!isRecord(value)) return {};
    const places = value.places;
    return {
      places: typeof places === "number" && Number.isSafeInteger(places) && places > 0 ? places : undefined,
      output: typeof value.output === "string" ? value.output : undefined,
    };
  } catch {
    return {};
  }
}

function readHistory(): Snapshot[] {
  try {
    const snapshots: Snapshot[] = [];
    for (const line of readFileSync(join(inputDir, "history.ndjson"), "utf8")
      .split(/\r?\n/)
      .filter((item) => item.trim().length > 0)) {
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value)) snapshots.push(value as Snapshot);
      } catch {
        // Ignore one malformed record and keep the usable history.
      }
    }
    return snapshots;
  } catch {
    return [];
  }
}

function gamesFrom(snapshot: Snapshot): Game[] {
  const rows = isRecord(snapshot) && Array.isArray(snapshot.top_trending) ? snapshot.top_trending : [];
  const parsed = rows
    .filter(isRecord)
    .map((row) => ({
      rank: row.rank,
      universe_id: row.universe_id,
      playing: typeof row.playing === "number" && Number.isFinite(row.playing) && row.playing >= 0
        ? row.playing
        : 0,
    }))
    .filter((row): row is Game => typeof row.rank === "number" && Number.isSafeInteger(row.rank) && row.rank > 0
      && typeof row.universe_id === "number" && Number.isSafeInteger(row.universe_id) && row.universe_id > 0)
    .sort((a, b) => a.rank - b.rank || a.universe_id - b.universe_id);
  const seen = new Set<number>();
  return parsed.filter((row) => {
    if (seen.has(row.universe_id)) return false;
    seen.add(row.universe_id);
    return true;
  });
}

function rankOf(snapshot: Snapshot, universeId: number): number | null {
  const game = gamesFrom(snapshot).find((row) => row.universe_id === universeId);
  return game?.rank ?? null;
}

function gameOf(snapshot: Snapshot, universeId: number): Game | null {
  return gamesFrom(snapshot).find((row) => row.universe_id === universeId) ?? null;
}

function rankVolatility(history: Snapshot[], cutoffIndex: number, universeId: number): number {
  const recent = history.slice(Math.max(0, cutoffIndex - 8), cutoffIndex + 1).map((snapshot) => rankOf(snapshot, universeId));
  const changes: number[] = [];
  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1];
    const current = recent[index];
    if (previous !== null && current !== null) changes.push(Math.abs(current - previous));
  }
  return changes.length === 0 ? 0 : changes.reduce((sum, value) => sum + value, 0) / changes.length;
}

function historicalMomentum(history: Snapshot[], cutoffIndex: number, latest: Game[]): RankedGame[] {
  const candidateIds = new Set<number>();
  for (const snapshot of history.slice(Math.max(0, cutoffIndex - 5), cutoffIndex + 1)) {
    for (const game of gamesFrom(snapshot)) candidateIds.add(game.universe_id);
  }
  for (const game of latest) candidateIds.add(game.universe_id);

  const horizon = (offset: number, universeId: number): number => {
    if (cutoffIndex < offset) return 0;
    const past = rankOf(history[cutoffIndex - offset], universeId);
    const current = rankOf(history[cutoffIndex], universeId);
    return past === null || current === null ? 0 : past - current;
  };

  return [...candidateIds]
    .map((universeId) => {
      const observed = history
        .slice(Math.max(0, cutoffIndex - 5), cutoffIndex + 1)
        .map((snapshot) => gameOf(snapshot, universeId))
        .filter((value): value is Game => value !== null);
      const latestGame = latest.find((game) => game.universe_id === universeId);
      const fallbackRank = observed.length > 0
        ? Math.min(100, Math.max(1, Math.min(...observed.map((value) => value.rank)) + 10))
        : 100;
      const game = latestGame ?? {
        rank: fallbackRank,
        universe_id: universeId,
        playing: observed.length > 0 ? observed[observed.length - 1].playing : 0,
      };
      const short = horizon(1, game.universe_id);
      const medium = horizon(Math.min(3, cutoffIndex), game.universe_id);
      const long = horizon(Math.min(8, cutoffIndex), game.universe_id);
      const windows = [short, medium, long];
      const mean = windows.reduce((sum, value) => sum + value, 0) / windows.length;
      const dispersion = windows.reduce((sum, value) => sum + Math.abs(value - mean), 0) / windows.length;
      const nonZeroDirections = windows.filter((value) => value !== 0);
      const direction = mean === 0 ? 0 : Math.sign(mean);
      const agreeingWindows = nonZeroDirections.filter((value) => Math.sign(value) === direction).length;
      const directionConsistency = nonZeroDirections.length === 0 ? 0 : agreeingWindows / nonZeroDirections.length;
      const consistency = directionConsistency / (1 + dispersion / 4);
      const volatility = rankVolatility(history, cutoffIndex, game.universe_id);
      const confidence = consistency / (1 + volatility / 8);
      const momentum = mean * confidence;
      const first = observed[0] ?? game;
      const last = observed[observed.length - 1] ?? game;
      const rankSlope = observed.length > 1
        ? Math.max(-4, Math.min(4, (last.rank - first.rank) / (observed.length - 1)))
        : 0;
      const playerGrowth = observed.length > 1 && first.playing > 0 && last.playing > 0
        ? (Math.log1p(last.playing) - Math.log1p(first.playing)) / (observed.length - 1)
        : 0;
      const projectedRank = Math.max(1, Math.min(100, game.rank + 3 * rankSlope - 2 * playerGrowth));
      return {
        ...game,
        momentum,
        confidence,
        projectedRank,
      score: -0.45 * game.rank - 0.55 * projectedRank + 0.18 * momentum
        - (latestGame ? 0 : 0.4),
      };
    })
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.universe_id - b.universe_id);
}

function calibratedProbability(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0.5;
  return Math.min(0.6, Math.max(0.5, 0.5 + 0.1 * confidence));
}

function softRankProbabilities(
  ranked: RankedGame[],
  place: number,
): Array<{ game: RankedGame; weight: number }> {
  const candidates = ranked
    .map((game) => {
      const currentWeight = Math.exp(-Math.abs(game.rank - place) / 1.2);
      const projectedWeight = Math.exp(-Math.abs(game.projectedRank - place) / 1.2);
      const consistency = Math.min(1, Math.max(0, game.confidence));
      const weight = (0.45 * currentWeight + 0.55 * projectedWeight) * (0.75 + 0.25 * consistency)
        + (place === 1 ? 0.2 * Math.exp(-Math.abs(game.projectedRank - 2) / 1.2) : 0);
      return { game, weight: Number.isFinite(weight) && weight > 0 ? weight : 0 };
    })
    .sort((a, b) => b.weight - a.weight || a.game.projectedRank - b.game.projectedRank
      || a.game.rank - b.game.rank || a.game.universe_id - b.game.universe_id)
    .slice(0, 100);
  const total = candidates.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    return ranked.slice(0, 10).map((game) => ({ game, weight: 0.1 }));
  }
  return candidates.map((item) => ({ game: item.game, weight: 0.9995 * item.weight / total }));
}

function appendProbability(
  rows: Array<{ universe_id: number; place: number; p: number }>,
  universeId: number,
  place: number,
  probability: number,
): void {
  if (!Number.isSafeInteger(universeId) || universeId < 1 || !Number.isInteger(place) || place < 1 || place > 10) return;
  const p = Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : 0;
  rows.push({ universe_id: universeId, place, p });
}

function validateForecast(
  forecast: { probabilities: Array<{ universe_id: number; place: number; p: number }>; top10: number[] },
): void {
  if (forecast.top10.length !== 10 || new Set(forecast.top10).size !== 10) throw new Error("forecast top10 is not 10 unique games");
  if (forecast.top10.some((universeId) => !Number.isSafeInteger(universeId) || universeId < 1)) {
    throw new Error("forecast top10 contains an invalid universe id");
  }
  const sums = new Array<number>(10).fill(0);
  const counts = new Array<number>(10).fill(0);
  const maxRows = 10 * 100;
  if (forecast.probabilities.length > maxRows) throw new Error("forecast has too many probability rows");
  const seen = new Set<string>();
  for (const row of forecast.probabilities) {
    const key = row.universe_id + ":" + row.place;
    if (seen.has(key)) throw new Error("forecast repeats a game at one place");
    seen.add(key);
    if (!Number.isSafeInteger(row.universe_id) || row.universe_id < 1 || !Number.isInteger(row.place)
      || row.place < 1 || row.place > 10 || !Number.isFinite(row.p) || row.p < 0 || row.p > 1) {
      throw new Error("forecast contains an invalid probability row");
    }
    sums[row.place - 1] += row.p;
    counts[row.place - 1] += 1;
  }
  if (counts.some((count) => count > 100)) throw new Error("forecast has more than 100 rows at one place");
  if (sums.some((sum) => !Number.isFinite(sum) || sum > 1 + 1e-9)) throw new Error("forecast probability mass exceeds 1");
}

function selectTopGames(ranked: RankedGame[], count: number): number[] {
  const selected: number[] = [];
  const seen = new Set<number>();
  for (const game of ranked) {
    if (!Number.isSafeInteger(game.universe_id) || game.universe_id < 1 || seen.has(game.universe_id)) continue;
    selected.push(game.universe_id);
    seen.add(game.universe_id);
    if (selected.length === count) break;
  }
  if (selected.length !== count) throw new Error("not enough unique valid games for top10");
  return selected;
}

function main(): void {
  const task = readTask();
  if (task.places !== 10) throw new Error("unsupported task: places must be 10");
  if (task.output !== "forecast.json") throw new Error("unsupported task: output must be forecast.json");
  const placeCount = task.places;
  const history = readHistory();
  let cutoffIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (gamesFrom(history[index]).length > 0) {
      cutoffIndex = index;
      break;
    }
  }
  if (cutoffIndex < 0) throw new Error("no usable history snapshot was found");
  const latest = cutoffIndex >= 0 ? gamesFrom(history[cutoffIndex]) : [];
  if (latest.length < placeCount) throw new Error("usable history has fewer than 10 unique games");
  const ranked = historicalMomentum(history, Math.max(0, cutoffIndex), latest);
  const candidates = ranked;
  if (candidates.length < placeCount) throw new Error("forecast cannot form 10 unique games");
  const top10 = selectTopGames(ranked, placeCount);
  const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];

  for (let place = 1; place <= placeCount; place += 1) {
    const distribution = softRankProbabilities(candidates, place);
    for (const item of distribution) {
      appendProbability(probabilities, item.game.universe_id, place, item.weight);
    }
  }

  const output = {
    probabilities,
    top10,
  };
  validateForecast(output);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, task.output), JSON.stringify(output));
}

main();
