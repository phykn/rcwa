// Keep independent acceptance cases running while preserving every failure.
export async function runBrowserScenario(report, name, run) {
  const record = {
    name,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  report.groups.push(record);
  const started = Date.now();
  try {
    await run();
    record.status = "passed";
    return true;
  } catch (error) {
    record.status = "failed";
    record.error = error.stack || String(error);
    report.issues.push(`${name}: ${record.error}`);
    return false;
  } finally {
    record.elapsedMs = Date.now() - started;
  }
}
