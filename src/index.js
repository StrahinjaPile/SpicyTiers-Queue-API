export default {
    async fetch(request, env) {
        return new Response(
            JSON.stringify({
                success: true,
                service: "SpicyTiers Ranked API",
                status: "online"
            }),
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
    }
};
