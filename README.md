<img src="/public/img/logo.svg" width="128" align="right">

# WebhookProxy
A Discord webhook proxy, primarily for Roblox games.

# Why?
Discord banned Roblox from making webhooks again, primarily for abuse purposes. This proxy works around that.

# To host it yourself
<h2>
<a name="basic-setup-1" class="anchor" href="#basic-setup-1"></a>Basic Setup</h2>
<p>This setup just exposes the proxy publicly with no reverse proxy. Recommended to start with <strong>only</strong>, but you should probably use the correct setup as soon as possible.</p>
<ul>
<li>Install <a href="https://nodejs.org/" rel="noopener nofollow ugc"><code>Node.js</code></a> on your server. This can be done through a package manager or through <a href="https://nvm.sh/" rel="noopener nofollow ugc"><code>nvm</code> </a>. The minimum requirement is v16.</li>
<li>Install <code>git</code>. This is usually a default tool nowadays, but just grab it off of your package manager if you don’t have it.</li>
<li>Install <a href="https://redis.io/" rel="noopener nofollow ugc"><code>Redis</code> </a> or its Windows equivalent <a href="https://www.memurai.com/" rel="noopener nofollow ugc"><code>Memurai</code> </a> (please note Memurai is paid software and you should probably just go put Redis in a Docker container instead on Windows, however for testing purposes Memurai will work fine). You need at least v6.2 due to the commands used, though v7 and above is preferable.</li>
<li>Install <code>pm2</code> and <code>yarn</code> (<code>npm i -g pm2 yarn</code>)</li>
<li>Run <code>git clone https://github.com/LewisTehMinerz/webhook-proxy</code> to clone the proxy.</li>
<li>Enter the resultant <code>webhook-proxy</code> folder.</li>
<li>Copy the <code>.example.json</code> files to the same name, just without <code>.example</code> (e.g., <code>config.example.json</code> → <code>config.json</code>).</li>
<li>Modify the files as you need, primarily <code>config.json</code>.</li>
<li>Run <code>yarn &amp;&amp; yarn build</code>. This will install the necessary dependencies and build the project.</li>
<li>Run <code>pm2 start dist/index.js --name=webhook-proxy</code>. This will start the app under the name <code>webhook-proxy</code> in pm2.
<ul>
<li>If you wish to run this on startup, run <code>pm2 startup</code>, follow the instructions there, and then run <code>pm2 save</code>.</li>
</ul>
</li>
<li>You should be good to go! Future updates just require a simple <code>yarn update</code>.</li>
</ul>
<h2>
<a name="the-correct-setup-2" class="anchor" href="#the-correct-setup-2"></a>Correct Setup</h2>
<p>This setup involves using a reverse proxy instead of exposing the server directly and using a cluster instead of a single process. This is recommended (and the correct way), but a bit more complicated. <s>This is how I actually run the proxy.</s> This is how I used to run the proxy. I’m now using Cloudflare Tunnel, however this is still the recommended way of doing things that keeps it simple.</p>
<ul>
<li>Install <code>nginx</code>. This will be our front-facing web server.</li>
<li>Update your configuration and set <code>trustProxy</code> to <code>true</code>.</li>
<li>Create a new site in <code>nginx</code> with the following configuration:</li>
</ul>
<pre class="codeblock-buttons"><div class="codeblock-button-wrapper"><use href="#copy"></use></div><code class="lang-nginx hljs language-nginx"><span class="hljs-section">server</span> {
    <span class="hljs-attribute">listen</span> <span class="hljs-number">80</span>;

    <span class="hljs-attribute">server_name</span> &lt;domain name&gt;;

    <span class="hljs-section">location</span> / {
        <span class="hljs-attribute">proxy_set_header</span> X-Real-IP <span class="hljs-variable">$remote_addr</span>;
        <span class="hljs-attribute">proxy_set_header</span> X-Forwarded-For <span class="hljs-variable">$proxy_add_x_forwarded_for</span>;
        <span class="hljs-attribute">proxy_set_header</span> X-Forwarded-Proto <span class="hljs-variable">$scheme</span>;
        <span class="hljs-attribute">proxy_set_header</span> Host <span class="hljs-variable">$http_host</span>;
        <span class="hljs-attribute">proxy_set_header</span> X-NginX-Proxy <span class="hljs-literal">true</span>;

        <span class="hljs-attribute">proxy_pass</span> http://127.0.0.1:&lt;port&gt;;
        <span class="hljs-attribute">proxy_redirect</span> <span class="hljs-literal">off</span>;
    }
}
</code></pre>
<p><em>(it is recommended you enable SSL and HTTP2 but this is out of scope for this setup)</em></p>
<ul>
<li>Reload <code>nginx</code> and <code>pm2 restart webhook-proxy</code>. You should be good to go.</li>
<li>(Optional) Depending on your load requirements, you may want to cluster WebhookProxy to deal with a large amount of Roblox servers. If you have &gt;50 servers sending webhook requests frequently, you may need to scale. To do so, run <code>pm2 delete webhook-proxy</code>, and then run <code>pm2 start dist/index.js --name=webhook-proxy -i 1</code>. This will run it in a clustered mode instead of the standard <code>fork</code> mode.
<ul>
<li>From here, you can now scale the proxy up and down as you need to by doing <code>pm2 scale webhook-proxy &lt;worker count&gt;</code>. This is good for games that are growing that need to send a lot of webhook requests as you can just put on more workers as needed.</li>
<li>Please note that the benefits of clustering come from having multiple CPU cores. If you do not have more than one core on your server, this will not benefit you and will most likely <em>reduce</em> performance from the overhead of clustering and the workers fighting each other for resources.</li>
</ul>
</li>
</ul>
<h2>
<a name="enabling-queues-3" class="anchor" href="#enabling-queues-3"></a>Enabling Queues</h2>
<p>A new feature of the proxy is the queue system. This requires some extra (but simple) setup.</p>
<ul>
<li>Install <a href="https://www.rabbitmq.com/download.html" rel="noopener nofollow ugc">RabbitMQ <span class="badge badge-notification clicks" title="8 clicks">8</span></a>.</li>
<li>Edit your configuration to enable queues, and point to your RabbitMQ installation (it should just be the default value that I’ve provided, but in case you’ve changed anything you can set it here).</li>
<li>Restart the proxy (<code>pm2 restart webhook-proxy</code>).</li>
<li>Start the queue processor with <code>pm2 start dist/queueProcessor.js --name=webhook-proxy-processor</code>.
<ul>
<li>Run <code>pm2 save</code> as well if necessary.</li>
</ul>
</li>
<li>You should be good to go! Try adding <code>/queue</code> onto your webhook requests!</li>
</ul>
<p>With the newer updates of the proxy, you can now just run <code>yarn update</code> and, as long as you have the setup as described in this guide, it will automatically update the proxy for you. If a <code>yarn update</code> fails, try running it again. It could be that I updated the script.</p></div>
