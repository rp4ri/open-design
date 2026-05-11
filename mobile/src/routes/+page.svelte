<script lang="ts">
	import { app } from '../state.svelte';
	import {
		api,
		setDaemonConfig,
		filePreviewUrl,
		liveArtifactPreviewUrl,
		subscribeToProject,
		type SSEEvent
	} from '../daemon';

	let prompt = $state('');
	let connectInput = $state(app.daemonUrl);
	let connecting = $state(false);

	let newProjectName = $state('');
	let selectedSkill = $state('');
	let selectedDesignSystem = $state('');

	let touchStartX = $state(0);
	let sidebarTranslateX = $state(-100);

	let chatContainer: HTMLDivElement | undefined = $state();
	let unsubscribeProject: (() => void) | null = null;

	function scrollToBottom() {
		if (chatContainer) {
			requestAnimationFrame(() => {
				chatContainer!.scrollTop = chatContainer!.scrollHeight;
			});
		}
	}

	// --- Connection ---
	async function connect() {
		app.error = null;
		connecting = true;
		setDaemonConfig({ baseUrl: connectInput });
		try {
			await api.health();
			app.daemonUrl = connectInput;
			app.connected = true;
			await loadProjects();
			app.view = 'projects';
		} catch (e) {
			app.error = e instanceof Error ? e.message : 'Connection failed';
		} finally {
			connecting = false;
		}
	}

	async function loadProjects() {
		const res = await api.projects.list();
		app.projects = res.projects ?? res as any;
	}

	// --- Project selection ---
	async function selectProject(project: typeof app.projects[0]) {
		app.activeProject = project;
		app.sidebarOpen = false;
		app.view = 'chat';

		unsubscribeProject?.();
		unsubscribeProject = subscribeToProject(project.id, handleProjectEvent);

		try {
			const [convRes, artifactRes] = await Promise.all([
				api.conversations.list(project.id),
				api.liveArtifacts.list(project.id).catch(() => ({ artifacts: [] }))
			]);
			app.conversations = convRes.conversations ?? convRes as any;
			app.artifacts = artifactRes.artifacts ?? [];

			if (app.conversations.length > 0) {
				app.activeConversation = app.conversations[0];
				const msgRes = await api.messages.list(project.id, app.conversations[0].id);
				app.messages = msgRes.messages ?? msgRes as any;
				scrollToBottom();
			} else {
				app.activeConversation = null;
				app.messages = [];
			}
		} catch (e) {
			app.error = e instanceof Error ? e.message : 'Failed to load project';
		}
	}

	function handleProjectEvent(event: SSEEvent) {
		if (event.type === 'file_changed' || event.type === 'artifact_updated') {
			if (app.activeProject) {
				api.liveArtifacts.list(app.activeProject.id)
					.then((res) => { app.artifacts = res.artifacts ?? []; })
					.catch(() => {});
			}
		}
	}

	// --- New project ---
	async function openNewProject() {
		app.error = null;
		try {
			const [skillsRes, dsRes, agentsRes] = await Promise.all([
				api.skills.list(),
				api.designSystems.list(),
				api.agents.list().catch(() => ({ agents: [] }))
			]);
			app.skills = skillsRes.skills ?? skillsRes as any;
			app.designSystems = dsRes.designSystems ?? dsRes as any;
			app.agents = (agentsRes.agents ?? []).filter((a) => a.installed);
			app.view = 'new-project';
		} catch (e) {
			app.error = e instanceof Error ? e.message : 'Failed to load skills';
		}
	}

	async function createProject() {
		if (!newProjectName.trim()) return;
		app.error = null;
		try {
			const project = await api.projects.create({
				name: newProjectName.trim(),
				skillId: selectedSkill || undefined,
				designSystemId: selectedDesignSystem || undefined
			});
			newProjectName = '';
			selectedSkill = '';
			selectedDesignSystem = '';
			await loadProjects();
			await selectProject(project);
		} catch (e) {
			app.error = e instanceof Error ? e.message : 'Failed to create project';
		}
	}

	// --- Chat ---
	async function sendMessage() {
		if (!prompt.trim() || !app.activeProject || app.streaming) return;
		const text = prompt;
		prompt = '';
		app.streaming = true;

		app.messages = [
			...app.messages,
			{ id: crypto.randomUUID(), role: 'user', content: text }
		];
		scrollToBottom();

		const assistantId = crypto.randomUUID();
		app.messages = [
			...app.messages,
			{ id: assistantId, role: 'assistant', content: '', agentName: 'Agent' }
		];

		try {
			const res = await fetch(`${app.daemonUrl}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectId: app.activeProject.id,
					conversationId: app.activeConversation?.id,
					prompt: text,
					agentId: app.activeAgentId || undefined,
					skillId: app.activeProject.skillId || undefined,
					designSystemId: app.activeProject.designSystemId || undefined
				})
			});

			if (!res.ok) throw new Error(`Chat failed: ${res.status}`);

			const reader = res.body?.getReader();
			if (!reader) return;

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const raw = line.slice(6).trim();
					if (!raw || raw === '[DONE]') continue;
					try {
						const evt = JSON.parse(raw);
						if (evt.type === 'stdout' || evt.type === 'text') {
							const idx = app.messages.findIndex((m) => m.id === assistantId);
							if (idx !== -1) {
								const content = typeof evt.data === 'string' ? evt.data : evt.text ?? '';
								app.messages[idx] = {
									...app.messages[idx],
									content: app.messages[idx].content + content
								};
								scrollToBottom();
							}
						}
					} catch {}
				}
			}
		} catch (e) {
			app.error = e instanceof Error ? e.message : 'Stream failed';
		} finally {
			app.streaming = false;
			if (app.activeProject) {
				api.liveArtifacts.list(app.activeProject.id)
					.then((res) => { app.artifacts = res.artifacts ?? []; })
					.catch(() => {});
			}
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	// --- Preview ---
	function openArtifactPreview(artifactId: string) {
		if (!app.activeProject) return;
		app.previewUrl = liveArtifactPreviewUrl(app.activeProject.id, artifactId);
		app.view = 'preview';
	}

	function openFilePreview(fileName: string) {
		if (!app.activeProject) return;
		app.previewUrl = filePreviewUrl(app.activeProject.id, fileName);
		app.view = 'preview';
	}

	// --- Gestures ---
	function onTouchStart(e: TouchEvent) {
		touchStartX = e.touches[0].clientX;
	}

	function onTouchEnd(e: TouchEvent) {
		const dx = e.changedTouches[0].clientX - touchStartX;
		if (touchStartX < 30 && dx > 60) {
			app.sidebarOpen = true;
		} else if (app.sidebarOpen && dx < -60) {
			app.sidebarOpen = false;
		}
	}
</script>

<!-- ═══════════════ CONNECT ═══════════════ -->
{#if app.view === 'connect'}
	<div class="flex flex-1 items-center justify-center p-6">
		<div class="w-full max-w-sm space-y-4">
			<div class="text-center">
				<h1 class="text-2xl font-semibold tracking-tight">Open Design</h1>
				<p class="mt-1 text-sm text-text-secondary">Connect to your daemon</p>
			</div>

			<input
				type="url"
				bind:value={connectInput}
				placeholder="http://your-ec2:54069"
				class="w-full rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm
					text-text-primary outline-none transition-colors focus:border-accent"
			/>

			{#if app.error}
				<p class="text-center text-sm text-error">{app.error}</p>
			{/if}

			<button
				onclick={connect}
				disabled={!connectInput.trim() || connecting}
				class="w-full rounded-xl bg-accent py-3 text-sm font-medium
					text-white transition-colors active:bg-accent-hover
					disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent
					focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
			>
				{connecting ? 'Connecting...' : 'Connect'}
			</button>
		</div>
	</div>

<!-- ═══════════════ PREVIEW ═══════════════ -->
{:else if app.view === 'preview'}
	<header class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4"
		style="padding-top: env(safe-area-inset-top)">
		<button
			onclick={() => { app.view = 'chat'; app.previewUrl = null; }}
			aria-label="Back to chat"
			class="flex items-center gap-1 text-sm text-accent active:opacity-70"
		>
			<svg class="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-width="1.5" d="M15 19l-7-7 7-7" />
			</svg>
			Back
		</button>
		<span class="flex-1 truncate text-center text-xs text-text-muted">Preview</span>
	</header>
	<iframe
		src={app.previewUrl}
		title="Design preview"
		class="flex-1 border-none bg-white"
		sandbox="allow-scripts allow-same-origin"
	></iframe>

<!-- ═══════════════ NEW PROJECT ═══════════════ -->
{:else if app.view === 'new-project'}
	<header class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4"
		style="padding-top: env(safe-area-inset-top)">
		<button
			onclick={() => { app.view = 'projects'; }}
			aria-label="Back to projects"
			class="flex items-center gap-1 text-sm text-accent active:opacity-70"
		>
			<svg class="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-width="1.5" d="M15 19l-7-7 7-7" />
			</svg>
			Back
		</button>
		<span class="flex-1 text-center text-sm font-medium">New Project</span>
		<div class="w-12"></div>
	</header>

	<div class="flex-1 overflow-y-auto p-4 space-y-5">
		<div>
			<label for="proj-name" class="mb-1.5 block text-xs font-medium text-text-muted">Name</label>
			<input
				id="proj-name"
				bind:value={newProjectName}
				placeholder="My landing page"
				class="w-full rounded-xl border border-border bg-surface-raised px-4 py-3
					text-sm text-text-primary outline-none focus:border-accent"
			/>
		</div>

		<div>
			<label for="skill-select" class="mb-1.5 block text-xs font-medium text-text-muted">
				Skill ({app.skills.length})
			</label>
			<select
				id="skill-select"
				bind:value={selectedSkill}
				class="w-full rounded-xl border border-border bg-surface-raised px-4 py-3
					text-sm text-text-primary outline-none focus:border-accent"
			>
				<option value="">None (freeform)</option>
				{#each app.skills as skill}
					<option value={skill.id}>{skill.name}</option>
				{/each}
			</select>
		</div>

		<div>
			<label for="ds-select" class="mb-1.5 block text-xs font-medium text-text-muted">
				Design System ({app.designSystems.length})
			</label>
			<select
				id="ds-select"
				bind:value={selectedDesignSystem}
				class="w-full rounded-xl border border-border bg-surface-raised px-4 py-3
					text-sm text-text-primary outline-none focus:border-accent"
			>
				<option value="">None</option>
				{#each app.designSystems as ds}
					<option value={ds.id}>{ds.name}</option>
				{/each}
			</select>
		</div>

		{#if app.agents.length > 0}
			<div>
				<label for="agent-select" class="mb-1.5 block text-xs font-medium text-text-muted">
					Agent
				</label>
				<select
					id="agent-select"
					bind:value={app.activeAgentId}
					class="w-full rounded-xl border border-border bg-surface-raised px-4 py-3
						text-sm text-text-primary outline-none focus:border-accent"
				>
					<option value="">Default</option>
					{#each app.agents as agent}
						<option value={agent.id}>{agent.name}</option>
					{/each}
				</select>
			</div>
		{/if}

		{#if app.error}
			<p class="text-sm text-error">{app.error}</p>
		{/if}

		<button
			onclick={createProject}
			disabled={!newProjectName.trim()}
			class="w-full rounded-xl bg-accent py-3 text-sm font-medium text-white
				transition-colors disabled:opacity-40 active:bg-accent-hover"
		>
			Create Project
		</button>
	</div>

<!-- ═══════════════ MAIN (projects + chat) ═══════════════ -->
{:else}
	<!-- Header -->
	<header
		class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4"
		style="padding-top: env(safe-area-inset-top)"
	>
		<button
			onclick={() => { app.sidebarOpen = !app.sidebarOpen; }}
			aria-label="Toggle sidebar"
			class="flex size-8 items-center justify-center rounded-lg
				text-text-secondary transition-colors active:bg-surface-overlay"
		>
			<svg class="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-width="1.5" d="M4 6h16M4 12h16M4 18h16" />
			</svg>
		</button>

		<h1 class="flex-1 truncate text-sm font-medium">
			{app.activeProject?.name ?? 'Open Design'}
		</h1>

		{#if app.artifacts.length > 0}
			<button
				onclick={() => {
					if (app.artifacts.length > 0) openArtifactPreview(app.artifacts[0].id);
				}}
				aria-label="Preview artifact"
				class="flex size-8 items-center justify-center rounded-lg
					text-accent transition-colors active:bg-surface-overlay"
			>
				<svg class="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-width="1.5"
						d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
					<circle cx="12" cy="12" r="3" stroke-width="1.5" />
				</svg>
			</button>
		{/if}

		<div class="size-2 rounded-full {app.connected ? 'bg-success' : 'bg-error'}"></div>
	</header>

	<!-- Body with touch gestures -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="relative flex flex-1 overflow-hidden"
		ontouchstart={onTouchStart}
		ontouchend={onTouchEnd}
	>
		<!-- Sidebar overlay -->
		{#if app.sidebarOpen}
			<button
				class="absolute inset-0 z-10 bg-black/50 transition-opacity"
				onclick={() => { app.sidebarOpen = false; }}
				aria-label="Close sidebar"
			></button>
		{/if}

		<!-- Sidebar -->
		<aside
			class="absolute inset-y-0 left-0 z-20 w-72 overflow-y-auto
				border-r border-border bg-surface transition-transform duration-200
				{app.sidebarOpen ? 'translate-x-0' : '-translate-x-full'}"
		>
			<div class="flex items-center justify-between border-b border-border p-4">
				<h2 class="text-xs font-semibold uppercase tracking-wider text-text-muted">Projects</h2>
				<button
					onclick={openNewProject}
					aria-label="New project"
					class="flex size-7 items-center justify-center rounded-lg
						text-accent active:bg-surface-overlay"
				>
					<svg class="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-width="1.5" d="M12 5v14M5 12h14" />
					</svg>
				</button>
			</div>

			<div class="p-2">
				{#each app.projects as project}
					<button
						onclick={() => selectProject(project)}
						class="mb-0.5 w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors
							{app.activeProject?.id === project.id
							? 'bg-accent/10 text-accent'
							: 'text-text-secondary active:bg-surface-overlay'}"
					>
						<span class="block truncate">{project.name}</span>
						{#if project.updatedAt}
							<span class="block text-xs text-text-muted">
								{new Date(project.updatedAt).toLocaleDateString()}
							</span>
						{/if}
					</button>
				{/each}

				{#if app.projects.length === 0}
					<p class="px-3 py-6 text-center text-xs text-text-muted">No projects yet</p>
				{/if}
			</div>

			<div class="border-t border-border p-3">
				<button
					onclick={() => { app.view = 'connect'; app.connected = false; app.sidebarOpen = false; }}
					class="w-full rounded-lg px-3 py-2 text-left text-xs
						text-text-muted transition-colors active:bg-surface-overlay"
				>
					Disconnect
				</button>
			</div>
		</aside>

		<!-- Content -->
		<main class="flex flex-1 flex-col overflow-hidden">
			{#if app.view === 'projects' && !app.activeProject}
				<!-- Project list (full screen when no project selected) -->
				<div class="flex-1 overflow-y-auto p-4">
					<div class="mb-4 flex items-center justify-between">
						<h2 class="text-lg font-semibold">Projects</h2>
						<button
							onclick={openNewProject}
							class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white
								active:bg-accent-hover"
						>
							New
						</button>
					</div>

					<div class="space-y-2">
						{#each app.projects as project}
							<button
								onclick={() => selectProject(project)}
								class="w-full rounded-xl border border-border bg-surface-raised p-4
									text-left transition-colors active:bg-surface-overlay"
							>
								<span class="block text-sm font-medium">{project.name}</span>
								{#if project.skillId}
									<span class="mt-1 block text-xs text-text-muted">{project.skillId}</span>
								{/if}
							</button>
						{/each}

						{#if app.projects.length === 0}
							<div class="py-16 text-center">
								<p class="text-sm text-text-muted">No projects yet</p>
								<button
									onclick={openNewProject}
									class="mt-3 text-sm font-medium text-accent active:opacity-70"
								>
									Create your first project
								</button>
							</div>
						{/if}
					</div>
				</div>

			{:else if app.view === 'chat' && app.activeProject}
				<!-- Artifacts bar -->
				{#if app.artifacts.length > 0}
					<div class="flex shrink-0 gap-2 overflow-x-auto border-b border-border px-4 py-2">
						{#each app.artifacts as artifact}
							<button
								onclick={() => openArtifactPreview(artifact.id)}
								class="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5
									text-xs text-text-secondary transition-colors active:border-accent active:text-accent"
							>
								{artifact.title ?? artifact.kind ?? artifact.id.slice(0, 8)}
							</button>
						{/each}
					</div>
				{/if}

				<!-- Messages -->
				<div bind:this={chatContainer} class="flex-1 overflow-y-auto p-4 space-y-3">
					{#each app.messages as message}
						<div
							class="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
								{message.role === 'user'
								? 'ml-auto bg-accent text-white'
								: 'mr-auto bg-surface-raised text-text-primary'}"
						>
							{#if message.role === 'assistant' && message.agentName}
								<p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
									{message.agentName}
								</p>
							{/if}
							<p class="whitespace-pre-wrap break-words">{message.content}</p>
						</div>
					{/each}

					{#if app.streaming}
						<div class="mr-auto flex gap-1.5 px-4 py-3">
							<span class="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:0ms]"></span>
							<span class="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:150ms]"></span>
							<span class="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:300ms]"></span>
						</div>
					{/if}

					{#if app.messages.length === 0 && !app.streaming}
						<div class="flex h-full items-center justify-center">
							<p class="text-sm text-text-muted">Describe what you want to design</p>
						</div>
					{/if}
				</div>

				<!-- Input -->
				<div
					class="shrink-0 border-t border-border p-3"
					style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom))"
				>
					<div class="flex items-end gap-2">
						<textarea
							bind:value={prompt}
							onkeydown={handleKeydown}
							placeholder="Describe your design..."
							rows="1"
							class="max-h-32 flex-1 resize-none rounded-xl border border-border
								bg-surface-raised px-4 py-2.5 text-sm text-text-primary
								outline-none transition-colors
								placeholder:text-text-muted focus:border-accent"
						></textarea>

						<button
							onclick={sendMessage}
							disabled={!prompt.trim() || app.streaming}
							aria-label="Send message"
							class="flex size-10 shrink-0 items-center justify-center rounded-xl
								bg-accent text-white transition-colors
								disabled:opacity-40 active:bg-accent-hover"
						>
							<svg class="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
									d="M5 12h14M12 5l7 7-7 7" />
							</svg>
						</button>
					</div>
				</div>
			{/if}
		</main>
	</div>
{/if}
