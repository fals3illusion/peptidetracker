// Projection math. Shared by the browser and the tests.
// Weights are in pounds, times are ms since epoch.

const DAY = 86400000;

// Linear regression of weight over time. Each point can carry a weight
// (importance) so recent entries can count more than old ones.
export function fitLine(points, importanceOf = () => 1) {
  let sw = 0, sx = 0, sy = 0;
  for (const p of points) {
    const w = importanceOf(p);
    sw += w; sx += w * p.x; sy += w * p.y;
  }
  if (sw === 0) return null;
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  for (const p of points) {
    const w = importanceOf(p);
    sxx += w * (p.x - mx) ** 2;
    sxy += w * (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

// Returns a projection for one trend, or a reason it can't project.
function projectFrom(fit, lastX, goal, startWeight) {
  if (!fit) return { status: 'insufficient' };
  const perDay = fit.slope;
  const now = fit.intercept + fit.slope * lastX; // trend weight today
  const out = { perWeek: perDay * 7, trendWeight: now, fromX: lastX };
  if (goal == null) return { ...out, status: 'no-goal' };
  const losing = goal < startWeight;
  if ((losing && now <= goal) || (!losing && now >= goal)) return { ...out, status: 'reached' };
  const towardGoal = losing ? perDay < 0 : perDay > 0;
  if (!towardGoal || Math.abs(perDay) < 1e-6) return { ...out, status: 'wrong-direction' };
  return { ...out, status: 'ok', days: (goal - now) / perDay };
}

/**
 * entries: [{ t: ms, weight: lb }]
 * goal: goal weight in lb or null
 * opts.halfLifeDays: how fast old entries fade for the "recent" trend
 */
export function project(entries, goal, opts = {}) {
  const halfLifeDays = opts.halfLifeDays ?? 14;
  const minSpanDays = opts.minSpanDays ?? 3;
  const sorted = [...entries].sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return { status: 'insufficient', reason: 'Log at least 2 weigh-ins.' };
  const first = sorted[0].t, last = sorted[sorted.length - 1].t;
  if ((last - first) / DAY < minSpanDays) {
    return { status: 'insufficient', reason: `Need weigh-ins spread over at least ${minSpanDays} days.` };
  }
  // Work in days since the first entry to keep numbers small.
  const pts = sorted.map(e => ({ x: (e.t - first) / DAY, y: e.weight }));
  const lastX = pts[pts.length - 1].x;
  const startWeight = sorted[0].weight;

  const overallFit = fitLine(pts);
  const recentFit = fitLine(pts, p => 0.5 ** ((lastX - p.x) / halfLifeDays));

  const wrap = fit => {
    const r = projectFrom(fit, lastX, goal, startWeight);
    if (r.status === 'ok') r.date = first + (lastX + r.days) * DAY;
    if (r.fromX != null) r.fromT = first + r.fromX * DAY;
    delete r.fromX;
    return r;
  };
  return { status: 'ok', recent: wrap(recentFit), overall: wrap(overallFit) };
}

// Pace needed to hit the goal by a chosen date (lb per week, negative = losing).
export function requiredPace(currentWeight, goal, goalDateMs, nowMs) {
  const weeks = (goalDateMs - nowMs) / (7 * DAY);
  if (weeks <= 0) return null;
  return (goal - currentWeight) / weeks;
}
