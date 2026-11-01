export const exceptionSites = [
	{
		id: "QX-002",
		rule: "max-params",
		file: "src/context-tools.ts",
		selector: "function:registerContextTools/sdk:registerTool:new_context/execute:5",
	},
	{
		id: "QX-002",
		rule: "max-params",
		file: "src/context-tools.ts",
		selector: "function:registerContextTools/sdk:registerTool:get_context_remaining/execute:5",
	},
	{
		id: "QX-002",
		rule: "max-params",
		file: "src/notes.ts",
		selector: "function:registerNotes/sdk:registerTool:notes/execute:5",
	},
	{
		id: "QX-002",
		rule: "max-params",
		file: "src/history.ts",
		selector: "function:registerHistory/sdk:registerTool:history/execute:5",
	},
	{
		id: "QX-003",
		rule: "no-param-reassign",
		file: "test/native-host.ts",
		selector:
			'function:fixture/assign:faux.setResponses/callback:steps/call:setResponses/call:steps.map/callback:step/callback:ctx,opts,state,model/assignment:opts.cacheRetention="none"',
	},
	{
		id: "QX-003",
		rule: "no-param-reassign",
		file: "test/official-host.ts",
		selector:
			'function:fixture/assign:faux.setResponses/callback:steps/call:setResponses/call:steps.map/callback:step/callback:ctx,opts,state,model/assignment:opts.cacheRetention="none"',
	},
	{
		id: "QX-005",
		rule: "unicorn/no-useless-undefined",
		file: "test/native-host.ts",
		selector:
			'function:loadedHistory/method:call/variable:ctx=runner.createToolContext("history-regression", undefined)',
	},
	{
		id: "QX-010",
		rule: "typescript/no-unsafe-assignment",
		file: "test/native-host.ts",
		selector:
			"binding:createAgentSession,DefaultResourceLoader,discoverAndLoadExtensions,ExtensionRunner,ModelRuntime,ModelRegistry,SessionManager,SettingsManager,wrapRegisteredTools:typeof NativeSdk=await import(hostIndex)",
	},
	{
		id: "QX-010",
		rule: "typescript/no-unsafe-assignment",
		file: "test/native-host.ts",
		selector:
			"binding:fauxProvider,fauxAssistantMessage,fauxToolCall,getCurrentSystemPrompt,getCurrentTools,InMemoryCredentialStore:typeof NativeAi=await import(new URL(stringValue(aiExport.import), aiManifest).href)",
	},
] as const;
