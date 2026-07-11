let conversation = [];
document.querySelectorAll("[data-scope-id='turn']").forEach(el => {
    conversation.push({sender: "User", message: el.querySelector("div:first-child > div > div:first-child > div:nth-child(2) > div:first-child > div:first-child > span > span").innerHTML})
    aiArr = [];
    document.querySelectorAll("[data-scope-id='turn'] > div:nth-child(2) > div:first-child > div:first-child > div:nth-child(2) > div:first-child > [data-processed='true']").forEach(el => el.innerText.length > 0 ? aiArr.push(el.innerText) : null)
    conversation.push({sender: "AI", message: aiArr.join("\n")})
})
let markdown = "";
conversation.forEach(turn => {
    markdown += "## " + turn.sender + "\n\n"
    markdown += turn.message + "\n\n"
})
console.log(markdown)