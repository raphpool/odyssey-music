import { render } from "@testing-library/react-native";

import BootstrapScreen from "../app/index";

describe("BootstrapScreen", () => {
	it("renders the native bootstrap without calling a network boundary", () => {
		const screen = render(<BootstrapScreen />);

		expect(screen.getByText("track1")).toBeTruthy();
		expect(screen.getByText("Your daily music recommendation starts here.")).toBeTruthy();
	});
});
