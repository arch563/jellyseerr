// Simple test for the Add User Tag API endpoint
const axios = require('axios');

const baseURL = 'http://localhost:5055'; // Default Jellyseerr port

async function testAddUserTagAPI() {
    try {
        console.log('Testing Add User Tag API endpoint...');

        // Test the endpoint with a sample media ID
        const response = await axios.post(`${baseURL}/api/v1/media/1/add-user-tag`, {}, {
            headers: {
                'Content-Type': 'application/json',
                // Note: In a real test, you would need proper authentication headers
            }
        });

        console.log('API Response:', response.data);
        console.log('Status:', response.status);

    } catch (error) {
        if (error.response) {
            console.log('API Error Response:', error.response.data);
            console.log('Status:', error.response.status);
        } else {
            console.log('Network Error:', error.message);
        }
    }
}

// Run the test
testAddUserTagAPI();
