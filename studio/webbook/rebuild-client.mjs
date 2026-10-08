export async function autoRequest(book, body, request = fetch) {
  const response = await request('/local/auto-web/' + book, body ? {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
  } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export function pageJobs(jobs, page) {
  return jobs.filter(j => j.engine === 'css' && j.from <= page && j.to >= page)
    .sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export async function startRebuild(book, page, request = fetch) {
  const jobs = await autoRequest(book, undefined, request);
  const active = pageJobs(jobs, page).find(j => ['queued','running'].includes(j.state));
  return active || autoRequest(book, {from: page, to: page, engine: 'css'}, request);
}
export const rebuiltPageUrl = (book, job, page) => `/library/${book}/auto-web/${job.id}/web/${page}.html`;
