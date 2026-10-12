// Build the real static/live entries, inspect the full static-import closure and
// measure locally compressed bytes. These are dependency/size facts, not timing.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { build } from "vite";

const root = path.resolve(process.env.RCWA_BUNDLE_ROOT || ".");
const output = path.resolve(
  process.env.RCWA_BUNDLE_REPORT || "../artifacts/progressive-bundle-qa.json",
);
const checkSplit = process.env.RCWA_REQUIRE_PROGRESSIVE !== "false";
const sizes = (source) => {
  const bytes = Buffer.from(source);
  return {
    decoded_bytes: bytes.length,
    gzip_level_6_bytes: gzipSync(bytes, { level: 6 }).length,
    brotli_quality_5_bytes: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    }).length,
  };
};
const sum = (chunks) =>
  chunks.reduce(
    (total, chunk) => {
      for (const [key, value] of Object.entries(chunk.bytes))
        total[key] += value;
      return total;
    },
    { decoded_bytes: 0, gzip_level_6_bytes: 0, brotli_quality_5_bytes: 0 },
  );
const report = {
  status: "running",
  node: process.version,
  method:
    "Vite production write:false; complete output static-import closure; local gzip6/Brotli5, not HTTP transfer or phone timing. Per-file compressed totals sum independently compressed assets.",
  modes: [],
};
try {
  for (const mode of ["live", "static"]) {
    const result = await build({
      root,
      logLevel: "warn",
      define: {
        "import.meta.env.VITE_STATIC_PREVIEW": JSON.stringify(
          mode === "static" ? "true" : "",
        ),
      },
      build: { write: false },
    });
    assert.ok(!Array.isArray(result) && "output" in result);
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const entries = chunks.filter((chunk) => chunk.isEntry);
    assert.equal(entries.length, 1, "One application entry");
    const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const initial = new Set();
    function visit(name) {
      if (initial.has(name)) return;
      const chunk = byName.get(name);
      assert.ok(chunk, `Static import ${name} resolves inside the build`);
      initial.add(name);
      chunk.imports.forEach(visit);
    }
    visit(entries[0].fileName);
    const measured = chunks.map((chunk) => ({
      name: chunk.fileName,
      initial: initial.has(chunk.fileName),
      imports: chunk.imports,
      dynamic_imports: chunk.dynamicImports,
      modules: Object.keys(chunk.modules).map((name) =>
        name.replaceAll(root, "<root>"),
      ),
      bytes: sizes(chunk.code),
    }));
    const eagerThree = measured
      .filter((chunk) => chunk.initial)
      .flatMap((chunk) => chunk.modules)
      .filter((name) => /(?:\/three\/|OrbitControls)/.test(name));
    const lazyThree = measured
      .filter((chunk) => !chunk.initial)
      .flatMap((chunk) => chunk.modules)
      .filter((name) => /(?:\/three\/|OrbitControls)/.test(name));
    const html = result.output.find(
      (asset) => asset.type === "asset" && asset.fileName === "index.html",
    );
    assert.ok(html);
    const source = String(html.source);
    const preloads = [
      ...source.matchAll(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/g),
    ].map(([tag]) => tag.match(/href=["']([^"']+)/)?.[1]);
    if (checkSplit) {
      assert.deepEqual(
        eagerThree,
        [],
        "No Three or OrbitControls in any initial static dependency",
      );
      assert.ok(
        lazyThree.length > 0,
        "Automatic renderer enhancement retains Three in deferred chunks",
      );
      for (const preload of preloads) {
        assert.ok(
          preload && [...initial].some((name) => preload.endsWith(name)),
          "HTML never preloads a deferred renderer dependency",
        );
      }
    }
    const automaticStartups = {};
    for (const [schema, sourceName] of [
      ["two_dimensional", "StructureCanvas2D.tsx"],
      ["legacy_1d", "threeStructureRenderer.ts"],
    ]) {
      const renderer = chunks.find((chunk) =>
        chunk.facadeModuleId?.endsWith(`/${sourceName}`),
      );
      if (checkSplit)
        assert.ok(renderer, `${schema} has a deferred renderer entry`);
      const reachable = new Set(initial);
      function include(name) {
        if (reachable.has(name)) return;
        const chunk = byName.get(name);
        assert.ok(chunk);
        reachable.add(name);
        chunk.imports.forEach(include);
      }
      if (renderer) include(renderer.fileName);
      automaticStartups[schema] = {
        chunks: [...reachable],
        bytes: sum(measured.filter((chunk) => reachable.has(chunk.name))),
      };
    }
    const styles = result.output.filter(
      (asset) => asset.type === "asset" && asset.fileName.endsWith(".css"),
    );
    if (checkSplit)
      for (const style of styles)
        assert.ok(
          source.includes(style.fileName),
          "All scene/control CSS is linked eagerly in HTML",
        );
    report.modes.push({
      mode,
      entry: entries[0].fileName,
      initial_js: sum(measured.filter((chunk) => chunk.initial)),
      deferred_js: sum(measured.filter((chunk) => !chunk.initial)),
      all_build_js: sum(measured),
      automatic_startup_js: automaticStartups,
      eager_three_modules: eagerThree,
      deferred_three_modules: lazyThree,
      html_preloads: preloads,
      styles: styles.map((asset) => ({
        name: asset.fileName,
        bytes: sizes(asset.source),
      })),
      chunks: measured,
    });
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        report: output,
        modes: report.modes.map(({ chunks: _chunks, ...mode }) => mode),
      },
      null,
      2,
    ),
  );
}
