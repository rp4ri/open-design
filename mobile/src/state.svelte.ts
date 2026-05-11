import type { Project, Conversation, Message, Skill, DesignSystem, LiveArtifact } from './daemon';

type View = 'connect' | 'projects' | 'chat' | 'preview' | 'new-project';

class AppState {
	connected = $state(false);
	view = $state<View>('connect');

	projects = $state<Project[]>([]);
	activeProject = $state<Project | null>(null);

	conversations = $state<Conversation[]>([]);
	activeConversation = $state<Conversation | null>(null);
	messages = $state<Message[]>([]);

	skills = $state<Skill[]>([]);
	designSystems = $state<DesignSystem[]>([]);

	artifacts = $state<LiveArtifact[]>([]);
	previewUrl = $state<string | null>(null);

	agents = $state<Array<{ id: string; name: string; installed: boolean }>>([]);
	activeAgentId = $state<string | null>(null);
	activeRunId = $state<string | null>(null);
	streaming = $state(false);

	daemonUrl = $state('http://localhost:54069');
	error = $state<string | null>(null);

	sidebarOpen = $state(false);
}

export const app = new AppState();
