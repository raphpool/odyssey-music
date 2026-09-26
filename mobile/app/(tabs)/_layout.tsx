import { Tabs } from "expo-router";

export default function TabsLayout() {
	return (
		<Tabs
			backBehavior="history"
			detachInactiveScreens={false}
			initialRouteName="index"
			screenOptions={{
				headerShown: false,
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					tabBarAccessibilityLabel: "Aujourd'hui",
					tabBarLabel: "Aujourd'hui",
				}}
			/>
			<Tabs.Screen
				name="search"
				options={{
					tabBarAccessibilityLabel: "Recherche",
					tabBarLabel: "Recherche",
				}}
			/>
			<Tabs.Screen
				name="settings"
				options={{
					tabBarAccessibilityLabel: "Réglages",
					tabBarLabel: "Réglages",
				}}
			/>
		</Tabs>
	);
}
