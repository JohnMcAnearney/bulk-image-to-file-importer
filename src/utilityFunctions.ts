export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1048576).toFixed(2)} MB`;
}

export function clampQuality(v: number): number {
	return Math.max(1, Math.min(100, Math.round(v)));
}