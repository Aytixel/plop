class AccountButtonElement extends HTMLElement {
    constructor() {
        super()
    }

    async connectedCallback() {
        const seletor = `account-button[data-id="${this.dataset.id = Date.now()}"]`
        const style = document.createElement("style")
        const button = document.createElement("button")

        style.textContent += /*css*/`
            ${seletor} {
                display: inline-block;
            }
        `

        await Clerk.load()

        if (Clerk.user) {
            const image = document.createElement("img")
            const menu = document.createElement("div")

            button.ariaLabel = "Profil utilisateur"
            image.src = Clerk.user.imageUrl
            image.alt = "Photo de profile de la chaine"
            image.width = 32
            image.height = 32
            menu.ariaLabel = "Menu"
            menu.tabIndex = 0
            menu.hidden = true
            menu.classList.add("menu")
            menu.innerHTML += /*html*/`
                <div class="channel">
                    <img width="40" height="40" src="${Clerk.user.imageUrl}" alt="Photo de profile de la chaine">
                    <strong>${Clerk.user.username}</strong>
                </div>
                <hr>
                <button class="inverted account">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM12.1597 16C10.1243 16 8.29182 16.8687 7.01276 18.2556C8.38039 19.3474 10.114 20 12 20C13.9695 20 15.7727 19.2883 17.1666 18.1081C15.8956 16.8074 14.1219 16 12.1597 16ZM12 4C7.58172 4 4 7.58172 4 12C4 13.8106 4.6015 15.4807 5.61557 16.8214C7.25639 15.0841 9.58144 14 12.1597 14C14.6441 14 16.8933 15.0066 18.5218 16.6342C19.4526 15.3267 20 13.7273 20 12C20 7.58172 16.4183 4 12 4ZM12 5C14.2091 5 16 6.79086 16 9C16 11.2091 14.2091 13 12 13C9.79086 13 8 11.2091 8 9C8 6.79086 9.79086 5 12 5ZM12 7C10.8954 7 10 7.89543 10 9C10 10.1046 10.8954 11 12 11C13.1046 11 14 10.1046 14 9C14 7.89543 13.1046 7 12 7Z"></path></svg>
                    Compte
                </button>
                <button class="inverted logout">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M5 22C4.44772 22 4 21.5523 4 21V3C4 2.44772 4.44772 2 5 2H19C19.5523 2 20 2.44772 20 3V6H18V4H6V20H18V18H20V21C20 21.5523 19.5523 22 19 22H5ZM18 16V13H11V11H18V8L23 12L18 16Z"></path></svg>
                    Se déconnecter
                </button>
                <hr>
                <button class="inverted theme">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M10 7C10 10.866 13.134 14 17 14C18.9584 14 20.729 13.1957 21.9995 11.8995C22 11.933 22 11.9665 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C12.0335 2 12.067 2 12.1005 2.00049C10.8043 3.27098 10 5.04157 10 7ZM4 12C4 16.4183 7.58172 20 12 20C15.0583 20 17.7158 18.2839 19.062 15.7621C18.3945 15.9187 17.7035 16 17 16C12.0294 16 8 11.9706 8 7C8 6.29648 8.08133 5.60547 8.2379 4.938C5.71611 6.28423 4 8.9417 4 12Z"></path></svg>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M11.3807 2.01886C9.91573 3.38768 9 5.3369 9 7.49999C9 11.6421 12.3579 15 16.5 15C18.6631 15 20.6123 14.0843 21.9811 12.6193C21.6613 17.8537 17.3149 22 12 22C6.47715 22 2 17.5228 2 12C2 6.68514 6.14629 2.33869 11.3807 2.01886Z"></path></svg>
                    <span><span>
                </button>
            `
            style.textContent += /*css*/`
                ${seletor}>button {
                    --size: 2em;

                    min-width: 0;
                    width: var(--size);
                    min-height: 0;
                    height: var(--size);

                    padding: 0 !important;

                    border: none;
                    border-radius: calc(var(--size) / 2);
                }

                ${seletor}>button>img {
                    padding: 0;

                    width: inherit;
                    height: inherit;

                    border-radius: inherit;
                }

                ${seletor} .menu {
                    position: absolute;
                    top: 2.75em;
                    right: 0;

                    width: 20em;
    
                    border: solid .1em rgb(var(--color-dark) / .1);
                    border-radius: .5em;

                    overflow: hidden;
    
                    background-color: color-mix(in srgb, rgb(var(--color-dark) / .1) 50%, rgb(var(--color-light) / .9));

                    backdrop-filter: blur(10px);
                }

                ${seletor} .menu button {
                    width: 100%;

                    border: 0;
                    border-radius: 0;
                }

                ${seletor} .channel {
                    display: flex;
                    align-items: center;

                    margin: .5em;

                    height: 2.5em;
                }

                ${seletor} .channel img {
                    --inner-size: 2.5em;
                    --icon-margin: .5em;

                    border-radius: 1.25em;
                }

                ${seletor} hr {
                    margin: .5em 0;
                }
            `

            const theme = menu.getElementsByClassName("theme")[0]
            const theme_icons = theme.getElementsByTagName("svg")
            const theme_text = theme.getElementsByTagName("span")[0]

            function is_dark_theme() {
                return localStorage.getItem("theme") == "dark"
            }
            function update_theme_button() {
                if (is_dark_theme()) {
                    theme_text.textContent = "Thème sombre"
                    theme_icons[0].style.display = "none"
                    theme_icons[1].style.display = "inline"
                } else {
                    theme_text.textContent = "Thème clair"
                    theme_icons[0].style.display = "inline"
                    theme_icons[1].style.display = "none"
                }
            }

            update_theme_button()

            theme.addEventListener("click", () => {
                localStorage.setItem("theme", is_dark_theme() ? "light" : "dark")
                document.documentElement.classList.toggle("dark", is_dark_theme())
                update_theme_button()
            })
            menu.getElementsByClassName("account")[0].addEventListener("click", () => Clerk.redirectToUserProfile())
            menu.getElementsByClassName("logout")[0].addEventListener("click", async () => {
                await Clerk.session.remove()
                location.reload()
            })

            let timeout = null

            menu.addEventListener("focusin", () => {
                if (timeout !== null) {
                    clearTimeout(timeout)
                    timeout = null
                }
            })
            menu.addEventListener("focusout", () => timeout = setTimeout(() => menu.hidden = true, 100))
            button.addEventListener("click", () => {
                if (menu.hidden) {
                    menu.hidden = false
                    menu.focus()
                }
            })
            button.append(image)
            button.append(menu)
        } else {
            const span = document.createElement("span")

            button.innerHTML = /*html*/`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM12.1597 16C10.1243 16 8.29182 16.8687 7.01276 18.2556C8.38039 19.3474 10.114 20 12 20C13.9695 20 15.7727 19.2883 17.1666 18.1081C15.8956 16.8074 14.1219 16 12.1597 16ZM12 4C7.58172 4 4 7.58172 4 12C4 13.8106 4.6015 15.4807 5.61557 16.8214C7.25639 15.0841 9.58144 14 12.1597 14C14.6441 14 16.8933 15.0066 18.5218 16.6342C19.4526 15.3267 20 13.7273 20 12C20 7.58172 16.4183 4 12 4ZM12 5C14.2091 5 16 6.79086 16 9C16 11.2091 14.2091 13 12 13C9.79086 13 8 11.2091 8 9C8 6.79086 9.79086 5 12 5ZM12 7C10.8954 7 10 7.89543 10 9C10 10.1046 10.8954 11 12 11C13.1046 11 14 10.1046 14 9C14 7.89543 13.1046 7 12 7Z"></path></svg>`
            button.ariaLabel = "Se connecter"
            span.textContent = "Se connecter"

            button.classList.add("rounded", "collapse")
            button.addEventListener("click", () => Clerk.redirectToSignIn())
            button.append(span)
        }

        this.append(style)
        this.append(button)
    }
}

customElements.define("account-button", AccountButtonElement)