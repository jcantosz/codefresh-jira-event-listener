const https = require('https');

const config = {
    // Codefresh API key with pipeline approve access
    codefreshApiKey: process.env.CODEFRESH_API_KEY,

    webhookSecrets: (process.env.WEBHOOK_SECRETS) ? process.env.WEBHOOK_SECRETS.split(',') : null,

    // The names of the issue states that will cause the pipleine to be approved or denied
    states: {
        approve: process.env.APPROVE_STATES.split(','),
        deny: process.env.DENY_STATES.split(',')
    },

    // The event type(s) to listen for on the webhook, generally this will just be one event type
    eventTypes: process.env.EVENT_TYPES.split(','),

    // The field to look for the pipeline id in
    defaultPipelineCustomField: process.env.CUSTOM_FIELD,

    // Base URL of Codefresh (change if self-hosted)
    codefresh: {
        baseUrl: process.env.CODEFRESH_BASE_URL,
        port: parseInt(process.env.CODEFRESH_PORT)
    },
    // Set a jiraApiToken if you want your custom field to auto-resolve
    // needs access to issue metadata
    // jiraApi: { baseUrl: <jira url>, username: <username>, token: <token> },

    // See debug messages
    debug: process.env.DEBUG.toLowerCase() === 'true'
};

// Handle debug messages if switch is set
console.debug = (...args) => {
    if(config.debug) {
        console.log.apply(this, args)
    }
}

/**
 * Call codefresh to approve or deny the pipeline
**/
function approveDenyPipeline(action, workflowId) {
    console.log("%sing pipeline %s", action, workflowId);
    //https://g.codefresh.io/api/workflow/${WORKFLOW_ID}/pending-approval/approve

    // Prepare a request to approve/deny a pipeline
    let req = {
        host: config.codefresh.baseUrl,
        port: config.codefresh.port,
        path: '/api/workflow/' + workflowId + '/pending-approval/' + action,

        // authentication headers
        headers: {
            'Authorization':  config.codefreshApiKey
        }
    };

    // Do a GET request as an async action that we will wait for
    const promise = new Promise(function(resolve, reject) {

        // Send the request to Codefresh
        https.get(req, (res) => {
            console.debug("res", res);
            resolve(res.statusCode);
          }).on('error', (e) => {
            console.error(e);
            reject(Error(e));
          });
    });
    return promise;
}

/**
 * Get the name of Jira's custom field that holds the codefresh pipeline id
**/
function getPipelineIdField(projectKey){
    // TODO: use Jira API user/key toget project metadata and custom field, ex:
    //curl -H "Authorization: Basic ${JIRA_API_AUTH}"  -X GET -H "Content-Type: application/json" \
    // 'https://<JIRA_DOMAIN>.atlassian.net/rest/api/latest/issue/createmeta?projectKeys=<PROJECT_KEY>&expand=projects.issuetypes.fields'
    if (config.jiraApi) {
        if (config.jiraApi.baseUrl) {
            // parse the base url from the issue body
        }
        let encodedAuth = new Buffer(config.jiraApi.username + ':' + config.jiraApi.token).toString('base64');

    }
    return config.defaultPipelineCustomField;
}

/**
 * Webhook handler - On a POST to this listener from Jira, check a the issue's state.
 * If the state has changed and it has moved into one of the states  listed in the 'states' varaible, approve or deny the pipeline it based on what list it is in
 * For all cases, return a 200
**/
exports.handler = async (event, context) => {
    //parse data
    const body = JSON.parse(event.body);
    const parameters = event.queryStringParameters;
    const method = event.httpMethod;

    console.log("New request");
    console.debug("Debug mode ON");
    console.debug("event httpMethod: ", method);
    console.debug("event queryStringParameters: ", parameters);
    console.debug("event body: ", JSON.stringify(body));

    // Response
    let response = {
        statusCode: 200,
        body: JSON.stringify('Webhook received!'),
    };

    // If we have webhook secrets set and this message does not have one that matches on in the list, reject this message
    if (config.webhookSecrets.length !== 0 && (!parameters.webhook_secret || !config.webhookSecrets.includes(parameters.webhook_secret)) ){
        response.statusCode = 500;
        response.body = JSON.stringify("access denied");

    // If we are getting a webhook with data and are authenticated
    } else if (method == 'POST') {
        // Store the query string parameters
        const issueId = parameters.issue_id;
        const issueKey = parameters.issue_key;
        const projectKey = parameters.project_key;

        console.debug("issueId: %s, issueKey: %s, projectKey: %s", issueId, issueKey, projectKey);
        console.debug("body: %s", body);
        console.debug("issueType", body.issue.issue_event_type_name);
        console.debug("changeLog", body.issue.changelog);

        // If this is the event type we are interested in
        if (config.eventTypes.includes(body.issue_event_type_name)) {
            const changeItems = body.changelog.items;

            // Loop through the change list sent
            for (const item of changeItems){
                let action;
                const issueState = item.toString;
                const pipelineIdField = getPipelineIdField(projectKey);
                const workflowId = body.issue.fields[pipelineIdField];

                console.debug("Issue %s (%s) changed (change: %s) to %s", issueId, issueKey, item, issueState);
                console.debug("workflowId: ", workflowId);

                if (config.states.approve.includes(issueState)) {
                    action = 'approve';
                } else if (config.states.deny.includes(issueState)) {
                    action = 'deny';
                }

                console.debug("action: ", action);

                if (action) {
                    // wait for the request to resolve
                    await approveDenyPipeline(action, workflowId);
                }
            }
        }
    }
    console.log("Processing request finished");
    // Respond to the webhook
    return response;
};
