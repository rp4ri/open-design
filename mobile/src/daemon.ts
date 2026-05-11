export interface DaemonConfig {
	baseUrl: string;
}

let config: DaemonConfig = { baseUrl: 'http://localhost:54069' };

export function setDaemonConfig(c: DaemonConfig) {
	config = c;
}
export function getDaemonConfig(): DaemonConfig {
	return config;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${config.baseUrl}${path}`, {
		...init,
		headers: { 'Content-Type': 'application/json', ...init?.headers }
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json();
}

export interface Project {
	id: string;
	name: string;
	skillId?: string;
	designSystemId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Conversation {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
}

export interface Message {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	agentName?: string;
	startedAt?: string;
	endedAt?: string;
}

export type SSEEvent = { type: string; data: unknown };

export function subscribeToProject(
	projectId: string,
	onEvent: (event: SSEEvent) => void,
	onError?: (error: Event) => void
): () => void {
	const source = new EventSource(`${config.baseUrl}/api/projects/${projectId}/events`);
	source.onmessage = (e) => {
		try {
			onEvent(JSON.parse(e.data));
		} catch {
			onEvent({ type: 'raw', data: e.data });
		}
	};
	source.onerror = (e) => onError?.(e);
	return () => source.close();
}

export async function streamChat(
	projectId: string,
	conversationId: string,
	prompt: string,
	onEvent: (event: SSEEvent) => void,
	signal?: AbortSignal
): Promise<void> {
	const res = await fetch(
		`${config.baseUrl}/api/projects/${projectId}/conversations/${conversationId}/chat`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt }),
			signal
		}
	);
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
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				onEvent(JSON.parse(trimmed));
			} catch {
				onEvent({ type: 'raw', data: trimmed });
			}
		}
	}
}

export interface Skill {
	id: string;
	name: string;
	description: string;
}

export interface DesignSystem {
	id: string;
	name: string;
	description: string;
}

export interface ProjectFile {
	name: string;
	size?: number;
	kind?: string;
}

export interface LiveArtifact {
	id: string;
	title?: string;
	kind?: string;
	status?: string;
}

export interface ChatRun {
	runId: string;
}

export function filePreviewUrl(projectId: string, fileName: string): string {
	return `${config.baseUrl}/api/projects/${projectId}/files/${encodeURIComponent(fileName)}`;
}

export function liveArtifactPreviewUrl(projectId: string, artifactId: string): string {
	return `${config.baseUrl}/api/live-artifacts/${artifactId}/preview?projectId=${projectId}&variant=rendered`;
}

export async function startChatRun(body: {
	projectId: string;
	conversationId?: string;
	prompt: string;
	skillId?: string;
	designSystemId?: string;
	agentId?: string;
}): Promise<{ runId: string; eventSourceUrl: string }> {
	const run = await request<ChatRun>('/api/chat', {
		method: 'POST',
		body: JSON.stringify(body)
	});
	return {
		runId: run.runId,
		eventSourceUrl: `${config.baseUrl}/api/runs/${run.runId}/events`
	};
}

export function streamRunEvents(
	runId: string,
	onEvent: (event: SSEEvent) => void,
	onError?: (error: Event) => void
): () => void {
	const source = new EventSource(`${config.baseUrl}/api/runs/${runId}/events`);
	source.onmessage = (e) => {
		try {
			onEvent(JSON.parse(e.data));
		} catch {
			onEvent({ type: 'raw', data: e.data });
		}
	};
	source.onerror = (e) => onError?.(e);
	return () => source.close();
}

export const api = {
	health: () => request<{ ok: boolean }>('/api/health'),
	projects: {
		list: () => request<{ projects: Project[] }>('/api/projects'),
		get: (id: string) => request<Project>(`/api/projects/${id}`),
		create: (data: { name: string; skillId?: string; designSystemId?: string }) =>
			request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
		files: (id: string) => request<{ files: ProjectFile[] }>(`/api/projects/${id}/files`),
		delete: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' })
	},
	conversations: {
		list: (projectId: string) =>
			request<{ conversations: Conversation[] }>(`/api/projects/${projectId}/conversations`),
		create: (projectId: string, data?: { title?: string }) =>
			request<Conversation>(`/api/projects/${projectId}/conversations`, {
				method: 'POST',
				body: JSON.stringify(data ?? {})
			})
	},
	messages: {
		list: (projectId: string, convId: string) =>
			request<{ messages: Message[] }>(`/api/projects/${projectId}/conversations/${convId}/messages`)
	},
	skills: {
		list: () => request<{ skills: Skill[] }>('/api/skills')
	},
	designSystems: {
		list: () => request<{ designSystems: DesignSystem[] }>('/api/design-systems')
	},
	agents: {
		list: () => request<{ agents: Array<{ id: string; name: string; installed: boolean }> }>('/api/agents')
	},
	liveArtifacts: {
		list: (projectId: string) =>
			request<{ artifacts: LiveArtifact[] }>(`/api/live-artifacts?projectId=${projectId}`)
	},
	runs: {
		list: (opts?: { projectId?: string }) =>
			request<{ runs: Array<{ id: string; status: string }> }>(
				`/api/runs${opts?.projectId ? `?projectId=${opts.projectId}` : ''}`
			),
		cancel: (runId: string) =>
			request<{ ok: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' })
	}
};
