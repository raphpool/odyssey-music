import {
	createContext,
	createElement,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

import type { Profile } from "./model";
import { type ProfileRead, ProfileStore } from "./store";

type ProfileContextValue = {
	ready: boolean;
	state: ProfileRead;
	reload(): Promise<ProfileRead>;
};

const missing: ProfileRead = { kind: "missing" };
const ProfileContext = createContext<ProfileContextValue>({
	ready: true,
	state: missing,
	reload: async () => missing,
});

export function ProfileProvider({ children, store }: PropsWithChildren<{ store?: ProfileStore }>) {
	const profileStore = useMemo(() => store ?? new ProfileStore(), [store]);
	const [state, setState] = useState<ProfileRead>(missing);
	const [ready, setReady] = useState(false);
	const reload = useCallback(async (): Promise<ProfileRead> => {
		const next = await profileStore.read();
		setState(next);
		setReady(true);
		return next;
	}, [profileStore]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const value = useMemo<ProfileContextValue>(() => ({ ready, state, reload }), [ready, reload, state]);
	return createElement(ProfileContext.Provider, { value }, children);
}

export function useProfile(): ProfileContextValue {
	return useContext(ProfileContext);
}

export function profileFromState(state: ProfileRead): Profile | undefined {
	return state.kind === "profile" ? state.profile : undefined;
}
