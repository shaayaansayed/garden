const result = await Bun.build({
  entrypoints: ['./personal.tsx'], outdir: './.personal', target: 'browser',
  minify: true, define: { 'process.env.NODE_ENV': '"production"' },
});
if (!result.success) throw new AggregateError(result.logs, 'Personal UI build failed');
// Import as text into the Worker so private assets pass through authentication.
await Bun.write('.personal/script.txt', await result.outputs[0].text());
await Bun.write('.personal/styles.txt', Bun.file('personal.css'));
export {};
