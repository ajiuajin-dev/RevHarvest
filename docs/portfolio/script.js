document.querySelector("#year").textContent = new Date().getFullYear();

const email = ["2117024465", "qq.com"].join("@");
const emailLink = document.querySelector("#email-link");
emailLink.href = `mailto:${email}`;
emailLink.setAttribute("aria-label", `发送邮件至 ${email}`);

const marquee = document.querySelector(".marquee div");
marquee.innerHTML += marquee.innerHTML;
