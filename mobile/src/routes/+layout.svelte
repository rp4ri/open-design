<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<div class="flex h-dvh flex-col overflow-hidden">
	{@render children()}
</div>
