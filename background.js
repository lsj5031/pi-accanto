chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.action.onClicked.addListener((tab) => {
  void chrome.sidePanel.open({ windowId: tab.windowId });
});
