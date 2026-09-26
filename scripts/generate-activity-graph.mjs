import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const user = process.env.ACTIVITY_GRAPH_USER || process.env.GITHUB_REPOSITORY_OWNER || "Iamliuxiaozhen";
const output = process.env.ACTIVITY_GRAPH_OUTPUT || "profile/activity-graph.svg";
const token = process.env.GITHUB_TOKEN;

const DAY = 24 * 60 * 60 * 1000;
const today = startOfUtcDay(new Date());
const from = new Date(today.getTime() - 364 * DAY);

try {
  const data = await fetchActivityData(user, from, today, token);
  const svg = renderActivityGraph(user, data.days, data.total, data.source);

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${svg.replace(/[ \t]+$/gm, "")}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

async function fetchActivityData(login, fromDate, toDate, authToken) {
  if (authToken) {
    try {
      return await fetchContributionCalendar(login, fromDate, toDate, authToken);
    } catch (error) {
      console.warn(`GraphQL contribution calendar failed, falling back to public data: ${error.message}`);
    }
  }

  try {
    return await fetchPublicContributions(login, fromDate, toDate);
  } catch (error) {
    console.warn(`Public contribution calendar failed, falling back to public events: ${error.message}`);
    return fetchPublicEvents(login, fromDate, toDate);
  }
}

async function fetchContributionCalendar(login, fromDate, toDate, authToken) {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "user-agent": "readme-activity-graph-generator",
    },
    body: JSON.stringify({
      query,
      variables: {
        login,
        from: fromDate.toISOString(),
        to: new Date(toDate.getTime() + DAY - 1).toISOString(),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL returned ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((item) => item.message).join("; "));
  }

  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) {
    throw new Error(`No contribution calendar found for ${login}`);
  }

  const byDate = new Map();
  for (const week of calendar.weeks) {
    for (const day of week.contributionDays) {
      byDate.set(day.date, day.contributionCount);
    }
  }

  return {
    days: buildDays(fromDate, toDate, (date) => byDate.get(formatDate(date)) || 0),
    total: calendar.totalContributions,
    source: "GitHub contributions",
  };
}

async function fetchPublicContributions(login, fromDate, toDate) {
  const byDate = new Map();
  const startYear = fromDate.getUTCFullYear();
  const endYear = toDate.getUTCFullYear();

  for (let year = startYear; year <= endYear; year += 1) {
    const response = await fetch(`https://github.com/users/${encodeURIComponent(login)}/contributions?from=${year}-01-01&to=${year}-12-31`, {
      headers: {
        "user-agent": "readme-activity-graph-generator",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub contributions page returned ${response.status}: ${await response.text()}`);
    }

    for (const day of parseContributionHtml(await response.text())) {
      byDate.set(day.date, day.count);
    }
  }

  const days = buildDays(fromDate, toDate, (date) => byDate.get(formatDate(date)) || 0);
  return {
    days,
    total: days.reduce((sum, day) => sum + day.count, 0),
    source: "GitHub public contributions",
  };
}

async function fetchPublicEvents(login, fromDate, toDate) {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/events/public?per_page=100`, {
    headers: {
      "user-agent": "readme-activity-graph-generator",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub public events returned ${response.status}: ${await response.text()}`);
  }

  const events = await response.json();
  const byDate = new Map();

  for (const event of events) {
    const date = formatDate(new Date(event.created_at));
    byDate.set(date, (byDate.get(date) || 0) + 1);
  }

  const days = buildDays(fromDate, toDate, (date) => byDate.get(formatDate(date)) || 0);
  return {
    days,
    total: days.reduce((sum, day) => sum + day.count, 0),
    source: "GitHub public events",
  };
}

function parseContributionHtml(html) {
  const days = [];
  const pattern = /<td\b[^>]*data-date="(\d{4}-\d{2}-\d{2})"[^>]*>[\s\S]*?<\/td>\s*<tool-tip\b[^>]*>([\s\S]*?)<\/tool-tip>/g;
  let match;

  while ((match = pattern.exec(html))) {
    const tooltip = decodeHtml(match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
    const countMatch = tooltip.match(/([\d,]+) contributions? on /);
    days.push({
      date: match[1],
      count: countMatch ? Number(countMatch[1].replaceAll(",", "")) : 0,
    });
  }

  if (!days.length) {
    throw new Error("No contribution days found in GitHub contributions page");
  }

  return days;
}

function buildDays(fromDate, toDate, countForDate) {
  const days = [];
  for (let time = fromDate.getTime(); time <= toDate.getTime(); time += DAY) {
    const date = new Date(time);
    days.push({
      date: formatDate(date),
      count: countForDate(date),
    });
  }
  return days;
}

function renderActivityGraph(login, days, total, source) {
  const width = 900;
  const height = 260;
  const pad = { left: 58, right: 26, top: 54, bottom: 48 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const weeks = buildWeeks(days);
  const maxCount = Math.max(1, ...weeks.map((week) => week.count));
  const points = weeks.map((week, index) => {
    const x = pad.left + (index / Math.max(1, weeks.length - 1)) * plotWidth;
    const y = pad.top + plotHeight - (week.count / maxCount) * plotHeight;
    return { x, y, ...week };
  });

  const line = points.map((point) => `${round(point.x)},${round(point.y)}`).join(" ");
  const area = [
    `M ${pad.left} ${pad.top + plotHeight}`,
    `L ${points.map((point) => `${round(point.x)} ${round(point.y)}`).join(" L ")}`,
    `L ${pad.left + plotWidth} ${pad.top + plotHeight}`,
    "Z",
  ].join(" ");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = Math.round(maxCount * ratio);
    const y = pad.top + plotHeight - plotHeight * ratio;
    return `
      <line x1="${pad.left}" y1="${round(y)}" x2="${pad.left + plotWidth}" y2="${round(y)}" stroke="#2f334d" stroke-width="1"/>
      <text x="${pad.left - 12}" y="${round(y + 4)}" text-anchor="end" class="muted">${value}</text>`;
  }).join("");
  const weekGrid = points.map((point) => `<line x1="${round(point.x)}" y1="${pad.top}" x2="${round(point.x)}" y2="${pad.top + plotHeight}" class="week-grid"/>`).join("");
  const pointDots = points.map((point, index) => `
      <circle cx="${round(point.x)}" cy="${round(point.y)}" r="3.2" class="point" style="animation-delay: ${250 + index * 24}ms">
        <title>${escapeXml(point.start)} to ${escapeXml(point.end)}: ${point.count} contributions</title>
      </circle>`).join("");
  const monthLabels = getMonthLabels(points)
    .map((label) => `<text x="${round(label.x)}" y="${height - 18}" text-anchor="middle" class="muted">${escapeXml(label.text)}</text>`)
    .join("");
  const recent = weeks.slice(-4).reduce((sum, week) => sum + week.count, 0);
  const updated = new Date().toISOString().slice(0, 10);

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(login)} activity graph</title>
  <desc id="desc">${escapeXml(source)} by week for the last year. Total: ${total}. Last 4 weeks: ${recent}.</desc>
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: #70a5fd; }
    .summary { font: 500 12px 'Segoe UI', Ubuntu, Sans-Serif; fill: #a9b1d6; }
    .muted { font: 500 11px 'Segoe UI', Ubuntu, Sans-Serif; fill: #565f89; }
    .week-grid { stroke: #2f334d; stroke-width: 1; opacity: 0.35; }
    .area { opacity: 0; animation: fadeArea 1s ease 0.35s forwards; }
    .line {
      stroke-dasharray: 1;
      stroke-dashoffset: 1;
      animation: drawLine 1.8s ease forwards;
    }
    .point {
      fill: #70a5fd;
      opacity: 0;
      transform-box: fill-box;
      transform-origin: center;
      animation: popPoint 0.35s ease forwards;
    }
    @keyframes drawLine { to { stroke-dashoffset: 0; } }
    @keyframes fadeArea { to { opacity: 1; } }
    @keyframes popPoint {
      from { opacity: 0; transform: scale(0.25); }
      to { opacity: 1; transform: scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .area, .line, .point {
        animation: none;
        opacity: 1;
        stroke-dashoffset: 0;
      }
    }
  </style>
  <defs>
    <linearGradient id="activityFill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#70a5fd" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#70a5fd" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="4.5" fill="#1a1b27"/>
  <text x="28" y="34" class="title">Contribution Graph</text>
  <text x="${width - 28}" y="32" text-anchor="end" class="summary">${total} total · ${recent} last 4 weeks · updated ${updated}</text>
  <g>
    ${weekGrid}
    ${yTicks}
    <path d="${area}" class="area" fill="url(#activityFill)"/>
    <polyline points="${line}" class="line" pathLength="1" fill="none" stroke="#70a5fd" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${pointDots}
    ${monthLabels}
  </g>
</svg>
`;
}

function buildWeeks(days) {
  const weeks = [];
  let currentWeek = null;

  for (const day of days) {
    const weekStart = formatDate(startOfUtcWeek(new Date(`${day.date}T00:00:00Z`)));
    if (!currentWeek || currentWeek.weekStart !== weekStart) {
      currentWeek = {
        weekStart,
        start: day.date,
        end: day.date,
        count: 0,
      };
      weeks.push(currentWeek);
    }

    currentWeek.end = day.date;
    currentWeek.count += day.count;
  }

  return weeks;
}

function getMonthLabels(points) {
  const labels = [];
  let previousMonth = "";
  for (const point of points) {
    const month = point.end.slice(5, 7);
    if (month !== previousMonth) {
      labels.push({
        x: point.x,
        text: new Date(`${point.end}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      });
    }
    previousMonth = month;
  }
  return labels;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}
